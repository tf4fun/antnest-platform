package docker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/netip"
	"strings"

	semconv "github.com/tf4fun/antnest-platform/libs/go/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

var (
	managementMeter         = otel.Meter("github.com/tf4fun/antnest-platform/runtime-controller/platform-docker")
	managementCapacityGauge = mustInt64Gauge(managementMeter.Int64Gauge("runtime.management.capacity"))
	managementCountGauge    = mustInt64Gauge(managementMeter.Int64Gauge("runtime.management.count"))
)

func mustInt64Gauge(instrument metric.Int64Gauge, err error) metric.Int64Gauge {
	if err != nil {
		panic(err)
	}
	return instrument
}

type NetworkIPAM struct {
	Subnet             string
	IPRange            string
	Gateway            string
	AuxiliaryAddresses map[string]string
}

type Network struct {
	Name       string
	IPAM       []NetworkIPAM
	Containers map[string]string
}

func (d *Driver) Capacity() platform.Capacity {
	if value, ok := d.capacity.Load().(platform.Capacity); ok {
		return value
	}
	return platform.Capacity{}
}

func (d *Driver) markCapacityUnknown() {
	previous := d.Capacity()
	d.capacity.Store(platform.Capacity{
		RuntimeCapacity: previous.RuntimeCapacity,
		RuntimeCount:    previous.RuntimeCount,
	})
}

func (d *Driver) refreshCapacity(ctx context.Context) {
	managed, err := d.engine.ListManagedContainers(ctx)
	if err != nil {
		d.markCapacityUnknown()
		return
	}
	d.refreshCapacityWithInventory(ctx, managed)
}

func (d *Driver) refreshCapacityWithInventory(ctx context.Context, managed []Container) {
	detailer, ok := d.engine.(interface {
		InspectNetworkDetails(context.Context, string) (Network, error)
	})
	if !ok {
		return
	}
	network, err := detailer.InspectNetworkDetails(ctx, d.config.ManagementNetwork)
	if err != nil {
		slog.WarnContext(ctx, "Runtime management capacity refresh failed",
			semconv.AntnestControllerScope, d.config.ControllerScope,
			semconv.AntnestManagementNetwork, d.config.ManagementNetwork,
			"error_class", "management_network_unavailable")
		d.markCapacityUnknown()
		return
	}
	snapshot, err := managementCapacity(network, managed)
	if err != nil {
		slog.WarnContext(ctx, "Runtime management IPAM details are ambiguous",
			semconv.AntnestControllerScope, d.config.ControllerScope,
			semconv.AntnestManagementNetwork, d.config.ManagementNetwork,
			"error_class", "management_ipam_ambiguous")
		d.markCapacityUnknown()
		return
	}
	d.capacity.Store(snapshot)
	labels := semconv.MetricAttributes(attribute.String(semconv.AntnestControllerScope, d.config.ControllerScope), attribute.String(semconv.AntnestManagementNetwork, d.config.ManagementNetwork))
	attributes := metric.WithAttributes(labels...)
	managementCapacityGauge.Record(ctx, int64(min(snapshot.RuntimeCapacity, math.MaxInt64)), attributes)
	managementCountGauge.Record(ctx, int64(min(snapshot.RuntimeCount, math.MaxInt64)), attributes)
}

func (d *Driver) admitRuntimeCapacity(ctx context.Context) error {
	d.refreshCapacity(ctx)
	snapshot := d.Capacity()
	if snapshot.Known && snapshot.RuntimeCount >= snapshot.RuntimeCapacity {
		return fmt.Errorf("management network %q has all %d Runtime slots occupied",
			d.config.ManagementNetwork, snapshot.RuntimeCapacity)
	}
	return nil
}

func lastIPv4(prefix netip.Prefix) netip.Addr {
	raw := prefix.Masked().Addr().As4()
	for i := 0; i < 32-prefix.Bits(); i++ {
		raw[3-i/8] |= 1 << (i % 8)
	}
	return netip.AddrFrom4(raw)
}

func managementCapacity(network Network, managed []Container) (platform.Capacity, error) {
	var pool, parent *netip.Prefix
	var config NetworkIPAM
	for _, candidate := range network.IPAM {
		subnet, err := netip.ParsePrefix(strings.TrimSpace(candidate.Subnet))
		if err != nil {
			return platform.Capacity{}, fmt.Errorf("management network %q has malformed IPAM subnet %q", network.Name, candidate.Subnet)
		}
		if !subnet.Addr().Is4() {
			continue
		}
		if parent != nil {
			return platform.Capacity{}, fmt.Errorf("management network %q has multiple IPv4 IPAM pools", network.Name)
		}
		subnet = subnet.Masked()
		selected := subnet
		if raw := strings.TrimSpace(candidate.IPRange); raw != "" {
			iprange, err := netip.ParsePrefix(raw)
			if err != nil || !iprange.Addr().Is4() {
				return platform.Capacity{}, fmt.Errorf("management network %q has malformed IPAM range %q", network.Name, candidate.IPRange)
			}
			iprange = iprange.Masked()
			if iprange.Bits() < subnet.Bits() || !subnet.Contains(iprange.Addr()) || !subnet.Contains(lastIPv4(iprange)) {
				return platform.Capacity{}, fmt.Errorf("management network %q has IPAM range %q outside subnet %q", network.Name, candidate.IPRange, candidate.Subnet)
			}
			selected = iprange
		}
		pool, parent = &selected, &subnet
		config = candidate
	}
	if pool == nil || parent == nil {
		return platform.Capacity{}, fmt.Errorf("management network %q has no IPv4 IPAM pool", network.Name)
	}
	reserved := map[netip.Addr]struct{}{}
	reserve := func(addr netip.Addr) {
		if pool.Contains(addr) {
			reserved[addr] = struct{}{}
		}
	}
	reserve(parent.Addr())
	reserve(lastIPv4(*parent))
	reservedAddr := func(raw string) error {
		addr, err := netip.ParseAddr(strings.TrimSpace(raw))
		if err != nil || !addr.Is4() {
			return fmt.Errorf("management network %q has malformed reserved IPv4 %q", network.Name, raw)
		}
		reserve(addr)
		return nil
	}
	if strings.TrimSpace(config.Gateway) != "" {
		if err := reservedAddr(config.Gateway); err != nil {
			return platform.Capacity{}, err
		}
	}
	for _, raw := range config.AuxiliaryAddresses {
		if err := reservedAddr(raw); err != nil {
			return platform.Capacity{}, err
		}
	}
	runtimeIDs := make(map[string]struct{}, len(managed))
	for _, container := range managed {
		if container.ID == "" {
			continue
		}
		if _, _, err := managedIdentity(container.Labels); err == nil {
			runtimeIDs[container.ID] = struct{}{}
		}
	}
	seen := map[netip.Addr]bool{}
	var count, runtimeOutside uint64
	for id, raw := range network.Containers {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		addr, err := endpointIPv4(raw)
		if err != nil {
			return platform.Capacity{}, fmt.Errorf("management network %q has malformed endpoint IPv4 %q", network.Name, raw)
		}
		if !parent.Contains(addr) {
			return platform.Capacity{}, fmt.Errorf("management network %q endpoint %q is outside the IPAM subnet", network.Name, raw)
		}
		_, runtime := runtimeIDs[id]
		if previous, ok := seen[addr]; ok {
			if previous != runtime {
				return platform.Capacity{}, fmt.Errorf("management network %q endpoint %q has conflicting ownership", network.Name, raw)
			}
			continue
		}
		seen[addr] = runtime
		if runtime {
			count++
			_, staticallyReserved := reserved[addr]
			if staticallyReserved || !pool.Contains(addr) {
				runtimeOutside++
			}
		} else {
			reserve(addr)
		}
	}
	size := uint64(1) << (32 - pool.Bits())
	capacity := runtimeOutside
	if uint64(len(reserved)) < size {
		capacity += size - uint64(len(reserved))
	}
	return platform.Capacity{
		RuntimeCapacity: capacity, RuntimeCount: count, Known: true,
	}, nil
}

func endpointIPv4(raw string) (netip.Addr, error) {
	if prefix, err := netip.ParsePrefix(raw); err == nil {
		addr := prefix.Addr()
		if addr.Is4() {
			return addr, nil
		}
		return netip.Addr{}, errors.New("not IPv4")
	}
	addr, err := netip.ParseAddr(raw)
	if err != nil || !addr.Is4() {
		return netip.Addr{}, errors.New("not IPv4")
	}
	return addr, nil
}

func isIPAMExhaustion(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 409 && apiErr.Status != 500 {
		return false
	}
	message := strings.ToLower(apiErr.Message)
	return strings.Contains(message, "no available ipv4 addresses") ||
		strings.Contains(message, "pool exhausted")
}
