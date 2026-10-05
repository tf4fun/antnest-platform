package instanceauth

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

type Sender struct {
	mu     sync.Mutex
	root   string
	issuer *Manager
	closed bool
}

func NewSender(parent string, issuer *Manager) (*Sender, error) {
	if issuer == nil {
		return nil, fmt.Errorf("instance issuer is required")
	}
	root, err := os.MkdirTemp(parent, "antnest-runtime-senders-")
	if err != nil {
		return nil, fmt.Errorf("private instance sender directory is unavailable")
	}
	return &Sender{root: root, issuer: issuer}, nil
}

func (s *Sender) Install(id Identity, record *Record, caller string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", fmt.Errorf("private instance sender is closed")
	}
	token, err := s.issuer.Open(id, record, caller)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(s.root, record.ConnectionID)
	if err := os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
		return "", fmt.Errorf("private instance sender directory is unavailable")
	}
	stat, err := os.Lstat(dir)
	if err != nil || !stat.IsDir() || stat.Mode().Perm() != 0700 {
		return "", fmt.Errorf("private instance sender directory is invalid")
	}
	path := filepath.Join(dir, "antnest-runtime")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if os.IsExist(err) {
		existing, readErr := ReadSenderFile(path)
		if readErr != nil || !bytes.Equal(existing, []byte(token)) {
			return "", fmt.Errorf("accepted instance sender bytes differ")
		}
		return path, nil
	}
	if err != nil {
		return "", fmt.Errorf("private instance sender file is unavailable")
	}
	_, writeErr := file.Write([]byte(token))
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("private instance sender write failed")
	}
	return path, nil
}

func ReadSenderFile(path string) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("private instance credential is unavailable")
	}
	defer func() { _ = file.Close() }()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm() != 0600 || stat.Size() < 43 || stat.Size() > 86 {
		return nil, fmt.Errorf("private instance credential is invalid")
	}
	owner, ok := stat.Sys().(*syscall.Stat_t)
	if !ok || owner.Uid != uint32(os.Geteuid()) {
		return nil, fmt.Errorf("private instance credential owner is invalid")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 87))
	if err != nil {
		return nil, fmt.Errorf("private instance credential is unavailable")
	}
	return raw, nil
}

func (s *Sender) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return os.RemoveAll(s.root)
}
