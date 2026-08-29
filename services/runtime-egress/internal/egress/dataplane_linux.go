//go:build linux

package egress

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	gatewayTUNName      = "antnest-gw0"
	gatewayTUNWriteWait = 100 * time.Millisecond
)

type linuxDataPlane struct {
	mu             sync.Mutex
	writeMu        sync.Mutex
	device         *os.File
	cancel         context.CancelFunc
	done           chan struct{}
	readErr        error
	restartBlocked bool
}

func newPlatformDataPlane() packetDataPlane { return &linuxDataPlane{} }

func (d *linuxDataPlane) Start(ctx context.Context, prefix netip.Prefix, mtu int, deliver func([]byte), fail func(error)) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.restartBlocked {
		return fmt.Errorf("Gateway data plane requires process restart after reader shutdown failure")
	}
	if d.device != nil {
		return nil
	}
	if deliver == nil {
		return fmt.Errorf("Gateway downlink receiver is required")
	}
	if fail == nil {
		return fmt.Errorf("Gateway data-plane failure receiver is required")
	}
	for _, binary := range []string{"ip", "nft", "conntrack"} {
		if _, err := exec.LookPath(binary); err != nil {
			return fmt.Errorf("Gateway dependency %s is unavailable: %w", binary, err)
		}
	}
	device, err := os.OpenFile("/dev/net/tun", os.O_RDWR|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return fmt.Errorf("open shared Gateway TUN: %w", err)
	}
	request, err := unix.NewIfreq(gatewayTUNName)
	if err != nil {
		_ = device.Close()
		return fmt.Errorf("create Gateway TUN request: %w", err)
	}
	request.SetUint16(unix.IFF_TUN | unix.IFF_NO_PI)
	if err := unix.IoctlIfreq(int(device.Fd()), unix.TUNSETIFF, request); err != nil {
		_ = device.Close()
		return fmt.Errorf("create shared Gateway TUN: %w", err)
	}
	gatewayAddress, err := gatewayAddress(prefix)
	if err != nil {
		_ = device.Close()
		return err
	}
	cleanup := func() {
		_ = device.Close()
		_ = runGatewayCommand(context.Background(), nil, "nft", "delete", "table", "inet", "antnest_gateway")
	}
	commands := [][]string{
		{"ip", "address", "replace", gatewayAddress.String() + "/" + strconv.Itoa(prefix.Bits()), "dev", gatewayTUNName},
		{"ip", "link", "set", "dev", gatewayTUNName, "mtu", strconv.Itoa(mtu), "up"},
		{"ip", "route", "replace", prefix.String(), "dev", gatewayTUNName},
	}
	for _, command := range commands {
		if err := runGatewayCommand(ctx, nil, command[0], command[1:]...); err != nil {
			cleanup()
			return err
		}
	}
	_ = runGatewayCommand(ctx, nil, "nft", "delete", "table", "inet", "antnest_gateway")
	if err := runGatewayCommand(ctx, []byte(gatewayNFTRules(prefix, gatewayTUNName)), "nft", "-f", "-"); err != nil {
		cleanup()
		return fmt.Errorf("install Gateway packet policy: %w", err)
	}
	if err := clearGatewayConntrack(ctx, prefix.String()); err != nil {
		cleanup()
		return fmt.Errorf("clear stale Gateway conntrack: %w", err)
	}
	readerCtx, cancel := context.WithCancel(context.Background())
	d.device = device
	d.cancel = cancel
	done := make(chan struct{})
	d.done = done
	d.readErr = nil
	go d.readLoop(readerCtx, device, done, deliver, fail)
	return nil
}

func (d *linuxDataPlane) WritePacket(packet []byte) error {
	d.mu.Lock()
	device := d.device
	readErr := d.readErr
	d.mu.Unlock()
	if device == nil {
		return ErrDataPlaneUnavailable
	}
	if readErr != nil {
		return fmt.Errorf("Gateway TUN reader failed: %w", readErr)
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	deadline := time.Now().Add(gatewayTUNWriteWait)
	for {
		written, err := device.Write(packet)
		if err == nil {
			if written != len(packet) {
				return fmt.Errorf("short Gateway TUN write: %d of %d bytes", written, len(packet))
			}
			return nil
		}
		if !errors.Is(err, unix.EAGAIN) && !errors.Is(err, unix.EWOULDBLOCK) {
			return fmt.Errorf("write Gateway TUN packet: %w", err)
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("Gateway TUN remained non-writable for %s: %w", gatewayTUNWriteWait, ErrDataPlaneBackpressure)
		}
		timeoutMillis := int((remaining + time.Millisecond - 1) / time.Millisecond)
		descriptors := []unix.PollFd{{Fd: int32(device.Fd()), Events: unix.POLLOUT}}
		ready, pollErr := unix.Poll(descriptors, timeoutMillis)
		if pollErr != nil {
			if errors.Is(pollErr, unix.EINTR) {
				continue
			}
			return fmt.Errorf("wait for Gateway TUN write readiness: %w", pollErr)
		}
		if ready == 0 {
			return fmt.Errorf("Gateway TUN write readiness timed out: %w", ErrDataPlaneBackpressure)
		}
		if descriptors[0].Revents&(unix.POLLERR|unix.POLLHUP|unix.POLLNVAL) != 0 {
			return fmt.Errorf("Gateway TUN write poll failed with events %#x", descriptors[0].Revents)
		}
	}
}

func (d *linuxDataPlane) SetDenied(ctx context.Context, address netip.Addr, denied bool) error {
	if !address.Is4() {
		return fmt.Errorf("Gateway deny address must be IPv4")
	}
	if err := runGatewayCommand(ctx, nil, "nft", "list", "set", "inet", "antnest_gateway", "denied_sources"); err != nil {
		return fmt.Errorf("verify Gateway deny set: %w", err)
	}
	if denied {
		if err := runGatewayCommand(ctx, nil, "nft", "add", "element", "inet", "antnest_gateway", "denied_sources", "{", address.String(), "}"); err != nil && !strings.Contains(err.Error(), "File exists") {
			return fmt.Errorf("install Gateway deny barrier: %w", err)
		}
		if err := clearGatewayConntrack(ctx, address.String()); err != nil {
			return err
		}
		return nil
	}
	if err := runGatewayCommand(ctx, nil, "nft", "delete", "element", "inet", "antnest_gateway", "denied_sources", "{", address.String(), "}"); err != nil {
		if strings.Contains(err.Error(), "No such file") || strings.Contains(err.Error(), "No such element") {
			return nil
		}
		return fmt.Errorf("remove Gateway deny barrier: %w", err)
	}
	return nil
}

func (d *linuxDataPlane) Close() error {
	d.mu.Lock()
	device := d.device
	cancel := d.cancel
	done := d.done
	d.device = nil
	d.cancel = nil
	d.done = nil
	d.readErr = nil
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	var result error
	if device != nil {
		d.writeMu.Lock()
		result = device.Close()
		d.writeMu.Unlock()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			result = errors.Join(result, fmt.Errorf("Gateway TUN reader did not stop"))
			d.mu.Lock()
			d.restartBlocked = true
			d.mu.Unlock()
		}
	}
	commandCtx, cancelCommand := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelCommand()
	if err := runGatewayCommand(commandCtx, nil, "nft", "delete", "table", "inet", "antnest_gateway"); err != nil && !strings.Contains(err.Error(), "No such file") {
		result = errors.Join(result, err)
	}
	return result
}

func (d *linuxDataPlane) readLoop(ctx context.Context, device *os.File, done chan struct{}, deliver func([]byte), fail func(error)) {
	defer close(done)
	buffer := make([]byte, 65_535)
	pollDescriptors := []unix.PollFd{{Events: unix.POLLIN}}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		pollDescriptors[0].Fd = int32(device.Fd())
		pollDescriptors[0].Revents = 0
		ready, err := unix.Poll(pollDescriptors, 1000)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			if ctx.Err() != nil || errors.Is(err, os.ErrClosed) {
				return
			}
			d.recordReaderFailure(device, fmt.Errorf("poll Gateway TUN: %w", err), fail)
			return
		}
		if ready == 0 {
			continue
		}
		revents := pollDescriptors[0].Revents
		if revents&(unix.POLLERR|unix.POLLHUP|unix.POLLNVAL) != 0 {
			if ctx.Err() != nil {
				return
			}
			d.recordReaderFailure(device, fmt.Errorf("Gateway TUN poll returned revents %#x", revents), fail)
			return
		}
		if revents&unix.POLLIN == 0 {
			continue
		}
		read, err := unix.Read(int(device.Fd()), buffer)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, os.ErrClosed) {
				return
			}
			d.recordReaderFailure(device, fmt.Errorf("read Gateway TUN: %w", err), fail)
			return
		}
		if read == 0 {
			continue
		}
		deliver(bytes.Clone(buffer[:read]))
	}
}

func (d *linuxDataPlane) recordReaderFailure(device *os.File, err error, fail func(error)) {
	d.mu.Lock()
	current := d.device == device
	if d.device == device {
		d.readErr = err
	}
	d.mu.Unlock()
	slog.Error("Gateway TUN reader stopped", "error", err)
	if current {
		fail(err)
	}
}

func gatewayAddress(prefix netip.Prefix) (netip.Addr, error) {
	prefix = prefix.Masked()
	if !prefix.Addr().Is4() || prefix.Bits() > 30 {
		return netip.Addr{}, fmt.Errorf("Gateway virtual CIDR must contain at least four IPv4 addresses")
	}
	address := prefix.Addr().Next()
	if !prefix.Contains(address) {
		return netip.Addr{}, fmt.Errorf("Gateway virtual CIDR has no gateway address")
	}
	return address, nil
}

func gatewayNFTRules(prefix netip.Prefix, interfaceName string) string {
	return fmt.Sprintf(`table inet antnest_gateway {
  set denied_sources { type ipv4_addr; }
  chain prerouting {
    type filter hook prerouting priority raw; policy accept;
    iifname %q ip saddr @denied_sources counter drop
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    iifname %q ip saddr %s meta l4proto tcp counter accept
    oifname %q ip daddr %s ct state established,related counter accept
    counter drop
  }
  chain input {
    type filter hook input priority filter; policy accept;
	 iifname %q ip saddr %s tcp dport 53 counter accept
    iifname %q ip saddr %s counter drop
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr %s counter masquerade
  }
}
`, interfaceName, interfaceName, prefix, interfaceName, prefix,
		interfaceName, prefix, interfaceName, prefix, prefix)
}

func clearGatewayConntrack(ctx context.Context, source string) error {
	if _, err := runGatewayCommandOutput(ctx, nil, "conntrack", "-D", "-s", source, "-p", "tcp"); err != nil && !isNoConntrackEntry(err) {
		return fmt.Errorf("delete Gateway conntrack entries: %w", err)
	}
	output, err := runGatewayCommandOutput(ctx, nil, "conntrack", "-L", "-s", source, "-p", "tcp")
	if err != nil {
		return fmt.Errorf("verify Gateway conntrack barrier: %w", err)
	}
	if conntrackOutputHasFlow(output) {
		return fmt.Errorf("Gateway conntrack barrier could not verify cleanup for %s", source)
	}
	return nil
}

func runGatewayCommand(ctx context.Context, stdin []byte, name string, args ...string) error {
	_, err := runGatewayCommandOutput(ctx, stdin, name, args...)
	return err
}

func runGatewayCommandOutput(ctx context.Context, stdin []byte, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	if stdin != nil {
		command.Stdin = bytes.NewReader(stdin)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("%s failed: %w: %s", name, err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}

func isNoConntrackEntry(err error) bool {
	var exitError *exec.ExitError
	return errors.As(err, &exitError) && exitError.ExitCode() == 1 &&
		strings.Contains(err.Error(), "0 flow entries have been deleted")
}
