package credentials

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"io"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type PasswordPolicy struct {
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint8
}

type PasswordConfig struct {
	Policy          PasswordPolicy
	MemoryBudgetKiB uint32
	MaxConcurrent   int
}

func DefaultPasswordConfig() PasswordConfig {
	return PasswordConfig{
		Policy:          PasswordPolicy{MemoryKiB: argonMemory, Iterations: argonIterations, Parallelism: argonParallelism},
		MemoryBudgetKiB: 128 * 1024,
		MaxConcurrent:   min(64, max(2, runtime.GOMAXPROCS(0))),
	}
}

func (c PasswordConfig) Validate() error {
	if !validPasswordPolicy(c.Policy) {
		return fmt.Errorf("Argon2 policy must use bounded positive parameters and at least 8 KiB per lane")
	}
	if c.MemoryBudgetKiB < 8 || c.MemoryBudgetKiB > 4*1024*1024 || c.Policy.MemoryKiB > c.MemoryBudgetKiB {
		return fmt.Errorf("Argon2 memory budget must be 8–4194304 KiB and fit the configured hash")
	}
	if c.MaxConcurrent < 1 || c.MaxConcurrent > 64 {
		return fmt.Errorf("Argon2 maximum concurrency must be 1–64")
	}
	return nil
}

func validPasswordPolicy(p PasswordPolicy) bool {
	return p.Parallelism >= 1 && p.Parallelism <= 16 && p.Iterations >= 1 && p.Iterations <= 10 &&
		p.MemoryKiB >= 8*uint32(p.Parallelism) && p.MemoryKiB <= 1024*1024
}

// Passwords is injected by the process composition root. Every production
// hash and verification must share the same Engine and working budget.
type Passwords interface {
	HashPassword(context.Context, string) (string, error)
	VerifyPassword(context.Context, string, string) (bool, error)
	NeedsRehash(string) (bool, error)
}

// LoginPasswords also prepares the rejection-only verifier used for identities
// without an active local credential. It must never become a stored credential.
type LoginPasswords interface {
	Passwords
	DummyHash(context.Context) (string, error)
}

type Engine struct {
	config      PasswordConfig
	kernel      func([]byte, []byte, uint32, uint32, uint8, uint32) []byte
	dummyRandom io.Reader

	mu      sync.Mutex
	queue   []*passwordWaiter
	stats   PasswordStats
	closed  bool
	running sync.WaitGroup
}

func NewEngine(config PasswordConfig) (*Engine, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	return &Engine{config: config, kernel: argon2.IDKey, dummyRandom: rand.Reader}, nil
}

func (e *Engine) HashPassword(ctx context.Context, password string) (string, error) {
	if len(password) < minimumPassword || len(password) > maximumPassword {
		return "", domain.InvalidArgument(fmt.Sprintf("password must contain between %d and %d bytes", minimumPassword, maximumPassword))
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	salt := make([]byte, argonSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	p := e.config.Policy
	digest, err := e.derive(ctx, password, salt, p)
	if err != nil {
		return "", err
	}
	return encodePassword(p, salt, digest), nil
}

// DummyHash avoids an unnecessary startup KDF by preparing a random rejection
// target. Verification still runs Argon2 with the complete configured cost.
// Reserve the same policy weight conservatively and join entropy reads before
// releasing capacity, including when cancellation or shutdown discards a result.
func (e *Engine) DummyHash(ctx context.Context) (string, error) {
	p := e.config.Policy
	release, err := e.acquire(ctx, p.MemoryKiB)
	if err != nil {
		return "", err
	}
	defer release()
	if err := e.resultError(ctx); err != nil {
		return "", err
	}
	entropy := make([]byte, argonSaltBytes+argonKeyBytes)
	defer clear(entropy)
	if _, err := io.ReadFull(e.dummyRandom, entropy); err != nil {
		return "", fmt.Errorf("generate dummy password verifier: %w", err)
	}
	if err := e.resultError(ctx); err != nil {
		return "", err
	}
	return encodePassword(p, entropy[:argonSaltBytes], entropy[argonSaltBytes:]), nil
}

func encodePassword(policy PasswordPolicy, salt, digest []byte) string {
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", policy.MemoryKiB, policy.Iterations, policy.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(digest))
}

func (e *Engine) VerifyPassword(ctx context.Context, encoded, password string) (bool, error) {
	stored, err := parseStoredPassword(encoded)
	if err != nil {
		return false, err
	}
	digest, err := e.derive(ctx, password, stored.salt, stored.policy)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(digest, stored.key) == 1, nil
}

func (e *Engine) NeedsRehash(encoded string) (bool, error) {
	stored, err := parseStoredPassword(encoded)
	if err != nil {
		return false, err
	}
	return stored.policy != e.config.Policy, nil
}

func (e *Engine) derive(ctx context.Context, password string, salt []byte, policy PasswordPolicy) ([]byte, error) {
	release, err := e.acquire(ctx, policy.MemoryKiB)
	if err != nil {
		return nil, err
	}
	defer release()
	if err := e.resultError(ctx); err != nil {
		return nil, err
	}
	// IDKey is synchronous and joins its own workers. Never release permits or
	// return on cancellation while the kernel still owns its memory.
	digest := e.kernel([]byte(password), salt, policy.Iterations, policy.MemoryKiB, policy.Parallelism, argonKeyBytes)
	if err := e.resultError(ctx); err != nil {
		clear(digest)
		return nil, err
	}
	return digest, nil
}

func (e *Engine) resultError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return passwordBusy("shutdown")
	}
	return nil
}

type storedPassword struct {
	policy PasswordPolicy
	salt   []byte
	key    []byte
}

func parseStoredPassword(encoded string) (storedPassword, error) {
	if len(encoded) > 256 {
		return storedPassword{}, ErrInvalidPasswordEncoding
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return storedPassword{}, ErrInvalidPasswordEncoding
	}
	parameters := strings.Split(parts[3], ",")
	if len(parameters) != 3 {
		return storedPassword{}, ErrInvalidPasswordEncoding
	}
	memory, memoryOK := passwordParameter(parameters[0], "m=", 32)
	iterations, iterationsOK := passwordParameter(parameters[1], "t=", 32)
	parallelism, parallelismOK := passwordParameter(parameters[2], "p=", 8)
	policy := PasswordPolicy{MemoryKiB: uint32(memory), Iterations: uint32(iterations), Parallelism: uint8(parallelism)}
	if !memoryOK || !iterationsOK || !parallelismOK || !validPasswordPolicy(policy) {
		return storedPassword{}, ErrInvalidPasswordEncoding
	}
	salt, saltErr := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	key, keyErr := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if saltErr != nil || keyErr != nil || len(salt) != argonSaltBytes || len(key) != argonKeyBytes ||
		base64.RawStdEncoding.EncodeToString(salt) != parts[4] || base64.RawStdEncoding.EncodeToString(key) != parts[5] {
		return storedPassword{}, ErrInvalidPasswordEncoding
	}
	return storedPassword{policy: policy, salt: salt, key: key}, nil
}

func passwordParameter(raw, prefix string, bits int) (uint64, bool) {
	value, ok := strings.CutPrefix(raw, prefix)
	if !ok || value == "" {
		return 0, false
	}
	parsed, err := strconv.ParseUint(value, 10, bits)
	return parsed, err == nil && parsed > 0 && strconv.FormatUint(parsed, 10) == value
}
