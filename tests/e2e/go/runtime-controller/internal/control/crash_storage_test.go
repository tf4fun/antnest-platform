//go:build unix

package control_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	dockerplatform "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/docker"
)

func crashStorageCommand(t *testing.T, target string, overrides map[string]string) (string, string) {
	t.Helper()
	root := crashTempDir(t)
	marker := filepath.Join(root, "called")
	if err := os.WriteFile(filepath.Join(root, "docker"), []byte("#!/bin/sh\nprintf called >> \"$CRASH_STORAGE_MARKER\"\nexit 73\n"), 0700); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "-test.run=^"+target+"$", "-test.timeout=8s")
	env := map[string]string{}
	for _, value := range os.Environ() {
		k, v, ok := strings.Cut(value, "=")
		if ok {
			env[k] = v
		}
	}
	delete(env, "ANTNEST_RUNTIME_CRASH_JOB")
	delete(env, "ANTNEST_RUNTIME_CRASH_EVIDENCE")
	delete(env, "ANTNEST_RUNTIME_CONTROLLER_CRASH_TEST")
	env["PATH"] = root + string(os.PathListSeparator) + os.Getenv("PATH")
	env["CRASH_STORAGE_MARKER"] = marker
	for key, value := range overrides {
		env[key] = value
	}
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.WaitDelay = time.Second
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatal("storage preflight child timed out")
	}
	if err == nil {
		t.Fatal("expected rejected storage or blocked external call")
	}
	called, _ := os.ReadFile(marker)
	return string(output), string(called)
}

func TestCrashStorageParentEntry(t *testing.T) {
	for _, mode := range []string{"cache-evidence", "dangling-evidence", "file-evidence", "cache-temp", "dangling-temp", "traversal-temp", "durable"} {
		t.Run(mode, func(t *testing.T) {
			root := crashTempDir(t)
			directory := filepath.Join(root, "evidence")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			env := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_CRASH_TEST": "true", "ANTNEST_RUNTIME_CRASH_EVIDENCE": directory}
			switch mode {
			case "cache-evidence":
				env["ANTNEST_RUNTIME_CRASH_EVIDENCE"] = filepath.Join(root, ".cache", "missing")
			case "dangling-evidence":
				alias := filepath.Join(root, "alias")
				if err := os.Symlink(filepath.Join(root, ".cache", "missing"), alias); err != nil {
					t.Fatal(err)
				}
				env["ANTNEST_RUNTIME_CRASH_EVIDENCE"] = alias
			case "file-evidence":
				file := filepath.Join(root, "file")
				if err := os.WriteFile(file, []byte("existing"), 0600); err != nil {
					t.Fatal(err)
				}
				env["ANTNEST_RUNTIME_CRASH_EVIDENCE"] = file
			case "cache-temp":
				env["TMPDIR"] = filepath.Join(root, ".cache", "missing")
			case "traversal-temp":
				// Keep the raw parent segment: filepath.Join would erase it.
				env["TMPDIR"] = root + "/unresolved-alias/../"
			case "dangling-temp":
				alias := filepath.Join(root, "alias")
				if err := os.Symlink(filepath.Join(root, ".cache", "missing"), alias); err != nil {
					t.Fatal(err)
				}
				env["TMPDIR"] = alias
			}
			output, called := crashStorageCommand(t, "TestRuntimeUpdateProcessCrashRecovery", env)
			if mode == "durable" {
				if called == "" {
					t.Fatalf("valid path did not reach fixture: %s", output)
				}
				return
			}
			if called != "" {
				t.Fatalf("invalid path reached Docker: %s", output)
			}
			if !strings.Contains(output, "invalid crash") {
				t.Fatalf("wrong rejection: %s", output)
			}
		})
	}
}

func TestCrashStorageChildEntry(t *testing.T) {
	for _, mode := range []string{"cache-job", "directory-job", "dangling-job", "cache-effects", "directory-effects", "dangling-effects", "empty-effects", "durable"} {
		t.Run(mode, func(t *testing.T) {
			root := crashTempDir(t)
			path := filepath.Join(root, "job.json")
			job := crashJob{Database: "not-a-postgresql-dsn", Events: filepath.Join(root, "effects")}
			switch mode {
			case "cache-job":
				path = filepath.Join(root, ".cache", "missing.json")
			case "directory-job":
				path = root
			case "dangling-job":
				if err := os.Symlink(filepath.Join(root, ".cache", "missing.json"), path); err != nil {
					t.Fatal(err)
				}
			case "cache-effects":
				job.Events = filepath.Join(root, ".cache", "missing", "effects")
			case "directory-effects":
				job.Events = root
			case "dangling-effects":
				if err := os.Symlink(filepath.Join(root, ".cache", "missing"), job.Events); err != nil {
					t.Fatal(err)
				}
			case "empty-effects":
				job.Events = ""
			}
			if !strings.HasSuffix(mode, "-job") {
				data, err := json.Marshal(job)
				if err != nil {
					t.Fatal(err)
				}
				if err = os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			output, called := crashStorageCommand(t, "TestRuntimeUpdateCrashChild", map[string]string{"ANTNEST_RUNTIME_CRASH_JOB": path})
			if called != "" {
				t.Fatal("child reached Docker")
			}
			if mode == "durable" {
				if !strings.Contains(output, "open dedicated crash database failed") {
					t.Fatalf("valid path did not reach database parser: %s", output)
				}
				return
			}
			if !strings.Contains(output, "invalid crash") {
				t.Fatalf("storage did not reject before reading/connecting: %s", output)
			}
			if strings.Contains(output, "open dedicated crash database failed") {
				t.Fatal("invalid storage reached database parser")
			}
		})
	}
}

type crashStorageEngine struct {
	dockerplatform.Engine
	calls *int
}

func (e crashStorageEngine) CreateContainer(context.Context, dockerplatform.ContainerSpec) (string, error) {
	*e.calls++
	return "fixture", nil
}
func (e crashStorageEngine) StartContainer(context.Context, string) error  { *e.calls++; return nil }
func (e crashStorageEngine) StopContainer(context.Context, string) error   { *e.calls++; return nil }
func (e crashStorageEngine) RemoveContainer(context.Context, string) error { *e.calls++; return nil }

func TestCrashStoragePhysicalEffects(t *testing.T) {
	for _, operation := range []string{"create", "start", "stop", "remove"} {
		t.Run(operation, func(t *testing.T) {
			calls := 0
			e := crashEngine{Engine: crashStorageEngine{calls: &calls}, events: filepath.Join(crashTempDir(t), ".cache", "missing", "effects")}
			var failure error
			var panicValue any
			func() {
				defer func() { panicValue = recover() }()
				switch operation {
				case "create":
					_, failure = e.CreateContainer(context.Background(), dockerplatform.ContainerSpec{})
				case "start":
					failure = e.StartContainer(context.Background(), "fixture")
				case "stop":
					failure = e.StopContainer(context.Background(), "fixture")
				case "remove":
					failure = e.RemoveContainer(context.Background(), "fixture")
				}
			}()
			if failure == nil || panicValue != nil {
				t.Fatalf("expected an error before the effect, got error=%v panic=%v", failure, panicValue)
			}
			if calls != 0 {
				t.Fatal("physical effect ran before invalid journal was rejected")
			}
		})
	}
}

func TestCrashStorageDiagnosticProbe(t *testing.T) {
	if os.Getenv("CRASH_STORAGE_DIAGNOSTIC") != "true" {
		t.Skip("subprocess only")
	}
	dockerCommand(t, context.Background(), "exec", "fixture-container", "true")
}

func TestCrashStorageDiagnosticEntry(t *testing.T) {
	root := crashTempDir(t)
	if err := os.Symlink(filepath.Join(root, ".cache", "missing"), filepath.Join(root, "fixture-container.log")); err != nil {
		t.Fatal(err)
	}
	output, called := crashStorageCommand(t, "TestCrashStorageDiagnosticProbe", map[string]string{"CRASH_STORAGE_DIAGNOSTIC": "true", "ANTNEST_RUNTIME_CRASH_EVIDENCE": root})
	if called != "" {
		t.Fatalf("invalid diagnostic output reached Docker: %s", output)
	}
	if !strings.Contains(output, "invalid crash") {
		t.Fatalf("wrong rejection: %s", output)
	}
}

func TestCrashStoragePaths(t *testing.T) {
	root := crashTempDir(t)
	for _, target := range []string{filepath.Join(root, ".cache", "missing"), filepath.Join(root, "ordinary-missing")} {
		alias := filepath.Join(root, "alias-"+filepath.Base(filepath.Dir(target)))
		if err := os.Symlink(target, alias); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{alias, filepath.Join(alias, "new", "report.json")} {
			if _, err := durableCrashPath(path); err == nil {
				t.Errorf("dangling alias accepted: %s", path)
			}
		}
	}
	if _, err := durableCrashPath(filepath.Join(root, ".cache", "report")); err == nil {
		t.Fatal("cache path accepted")
	}
	for _, path := range []string{root + "/unresolved-alias/../report", root + "/.cache/../report"} {
		if _, err := durableCrashPath(path); err == nil {
			t.Errorf("unclean path accepted before checking its ancestors: %s", path)
		}
	}
	if _, err := durableCrashPath(filepath.Join(root, "artifacts", "new", "report.json")); err != nil {
		t.Fatal(err)
	}
}

func TestCrashStorageFiles(t *testing.T) {
	root := crashTempDir(t)
	path := filepath.Join(root, "report.json")
	for _, value := range []string{"long original snapshot", "new"} {
		if err := writeCrashFile(path, []byte(value)); err != nil {
			t.Fatal(err)
		}
		data, err := readCrashFile(path)
		if err != nil || string(data) != value {
			t.Fatalf("snapshot mismatch: %q %v", data, err)
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("evidence is not private")
	}
	journal := filepath.Join(root, "effects")
	e := crashEngine{events: journal}
	e.record("create", "first")
	e.record("start", "first")
	data, err := readCrashFile(journal)
	if err != nil || string(data) != "create first\nstart first\n" {
		t.Fatal("append journal changed")
	}
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := writeCrashFile(path, []byte("bad")); err == nil {
		t.Fatal("linked output accepted")
	}
	if _, err := readCrashFile(path); err == nil {
		t.Fatal("linked input accepted")
	}
	data, _ = os.ReadFile(target)
	if string(data) != "unchanged" {
		t.Fatal("linked target changed")
	}
	fifo := filepath.Join(root, "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{root, fifo} {
		if _, err := readCrashFile(file); err == nil {
			t.Errorf("special input accepted: %s", file)
		}
		if err := writeCrashFile(file, []byte("bad")); err == nil {
			t.Errorf("special output accepted: %s", file)
		}
	}
}
