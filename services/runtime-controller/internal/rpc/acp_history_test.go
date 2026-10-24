package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
)

const historyRPCPath = "/internal/acp-incarnations/history"

type historyRPCPort struct {
	incarnationRPCStub
	calls   atomic.Int32
	history func(context.Context, acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error)
}

func (*incarnationRPCStub) History(context.Context, acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
	return acpincarnation.HistoryPage{}, errors.New("unexpected history call")
}
func (*incarnationHTTPPort) History(context.Context, acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
	return acpincarnation.HistoryPage{}, errors.New("unexpected history call")
}

func (p *historyRPCPort) History(ctx context.Context, input acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
	p.calls.Add(1)
	return p.history(ctx, input)
}

func historyRPCHandler(t *testing.T, port *historyRPCPort, budget time.Duration) *Handler {
	t.Helper()
	h, err := NewHandlerWithAcpIncarnations(&fakeService{}, observation.NewHub(), time.Second, budget, incarnationRPCSecurity(t), port, &preparationStub{})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func historyRPCPage(count int) acpincarnation.HistoryPage {
	p := acpincarnation.HistoryPage{MemberID: "acp-a", HistoryID: incarnationRPCRegistrationID, SnapshotRevision: fmt.Sprint(count), AfterSequence: "0", Items: []acpincarnation.HistoryEntry{}}
	for i := 1; i <= count; i++ {
		p.Items = append(p.Items, acpincarnation.HistoryEntry{Sequence: fmt.Sprint(i), Registration: acpincarnation.Registration{MemberID: p.MemberID, RegistrationID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i), IncarnationID: fmt.Sprintf("10000000-0000-4000-8000-%012x", i)}})
	}
	return p
}

func TestAcpHistoryHTTPReturnsCompleteLargePrivatePage(t *testing.T) {
	page := historyRPCPage(64)
	port := &historyRPCPort{history: func(_ context.Context, input acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
		if input.MemberID != "acp-a" || input.Cursor != nil {
			t.Error("history lost original member/first-page input")
		}
		return page, nil
	}}
	server := httptest.NewServer(historyRPCHandler(t, port, time.Second))
	defer server.Close()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL+historyRPCPath, strings.NewReader(`{"member_id":"acp-a","cursor":null}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(serviceauth.Header, "Bearer "+incarnationRPCToken("agent-acp-service"))
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("history did not return its private page: status=%d", response.StatusCode)
	}
	if len(raw) <= 8192 || len(raw) > 32768 {
		t.Fatalf("fixture did not exercise separate history response bound: %d", len(raw))
	}
	var actual acpincarnation.HistoryPage
	if err := json.Unmarshal(raw, &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, page) || port.calls.Load() != 1 || port.registerCalls != 0 || port.inspectCalls != 0 {
		t.Fatal("history lost records or invoked a different operation")
	}
}

func TestAcpHistoryRPCRejectsInvalidWireBeforeStorage(t *testing.T) {
	for _, body := range []string{
		`{"member_id":"acp-a"}`, `{"member_id":"acp-a","cursor":null,"scope":"foreign"}`,
		`{"member_id":"acp-a","cursor":null,"stop_receipt":{}}`, `{"member_id":"acp-a","member_id":"acp-b","cursor":null}`,
		`{"member_id":"acp-a\n","cursor":null}`, `{"member_id":"acp-a","cursor":{}}`,
		`{"member_id":"acp-a","cursor":{"history_id":"12345678-1234-4abc-8abc-1234567890ab","snapshot_revision":"01","after_sequence":"0"}}`,
		`{"member_id":"acp-a","cursor":{"history_id":"12345678-1234-4abc-8abc-1234567890ab","snapshot_revision":"9223372036854775808","after_sequence":"0"}}`,
		`{"member_id":"acp-a","cursor":{"history_id":"12345678-1234-4abc-8abc-1234567890ab","snapshot_revision":"1","after_sequence":"1"}}`,
	} {
		t.Run(body, func(t *testing.T) {
			port := &historyRPCPort{history: func(context.Context, acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
				t.Error("invalid request reached history")
				return historyRPCPage(0), nil
			}}
			response := incarnationRPCServe(t, historyRPCHandler(t, port, time.Second), incarnationRPCRequest(http.MethodPost, historyRPCPath, body, "agent-acp-service"))
			incarnationRPCError(t, response, 400, "invalid_request", false)
			if port.calls.Load() != 0 {
				t.Fatal("invalid wire reached storage")
			}
		})
	}
}

type historyUnreadBody struct{ reads int }

func (b *historyUnreadBody) Read([]byte) (int, error) {
	b.reads++
	return 0, errors.New("unauthorized body read")
}
func (*historyUnreadBody) Close() error { return nil }

func TestAcpHistoryRPCAuthenticatesBeforeReading(t *testing.T) {
	for _, caller := range []string{"", "agent-controller", "skill-registry"} {
		t.Run(caller, func(t *testing.T) {
			port := &historyRPCPort{}
			body := &historyUnreadBody{}
			request := incarnationRPCRequest(http.MethodPost, historyRPCPath, "", caller)
			request.Body = body
			response := incarnationRPCServe(t, historyRPCHandler(t, port, time.Second), request)
			status := 401
			if caller != "" {
				status = 403
			}
			if response.Code != status || body.reads != 0 || port.calls.Load() != 0 {
				t.Fatal("history authentication did not precede body/storage")
			}
		})
	}
}

func TestAcpHistoryRPCPreservesContinuationAndRejectsMalformedPage(t *testing.T) {
	cursor := acpincarnation.HistoryCursor{HistoryID: incarnationRPCRegistrationID, SnapshotRevision: "65", AfterSequence: "64"}
	valid := historyRPCPage(1)
	valid.SnapshotRevision = "65"
	valid.AfterSequence = "64"
	valid.Items[0].Sequence = "65"
	for _, bad := range []bool{false, true} {
		t.Run(fmt.Sprint(bad), func(t *testing.T) {
			port := &historyRPCPort{history: func(_ context.Context, input acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
				if input.Cursor == nil || *input.Cursor != cursor {
					t.Error("cursor changed before history read")
				}
				p := valid
				if bad {
					p.MemberID = "acp-b"
				}
				return p, nil
			}}
			raw, _ := json.Marshal(acpincarnation.HistoryRequest{MemberID: "acp-a", Cursor: &cursor})
			response := incarnationRPCServe(t, historyRPCHandler(t, port, time.Second), incarnationRPCRequest(http.MethodPost, historyRPCPath, string(raw), "agent-acp-service"))
			if bad {
				incarnationRPCError(t, response, 500, "internal_error", true)
			} else if response.Code != 200 {
				t.Fatalf("continuation refused: %d", response.Code)
			}
		})
	}
}

func TestAcpHistoryRPCCancellationJoinsOriginalPort(t *testing.T) {
	entered, cancelled, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	port := &historyRPCPort{history: func(ctx context.Context, _ acpincarnation.HistoryRequest) (acpincarnation.HistoryPage, error) {
		close(entered)
		<-ctx.Done()
		close(cancelled)
		<-release
		return acpincarnation.HistoryPage{}, errors.New("original cleanup sentinel")
	}}
	handler := historyRPCHandler(t, port, time.Second)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request := incarnationRPCRequest(http.MethodPost, historyRPCPath, `{"member_id":"acp-a","cursor":null}`, "agent-acp-service").WithContext(ctx)
	response := httptest.NewRecorder()
	go func() { defer close(returned); handler.ServeHTTP(response, request) }()
	defer func() {
		cancel()
		select {
		case <-release:
		default:
			close(release)
		}
		<-returned
	}()
	select {
	case <-entered:
	case <-returned:
		t.Fatal("history handler returned without entering original operation")
	case <-time.After(time.Second):
		t.Fatal("history port was not entered")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("history did not cancel its original operation")
	}
	select {
	case <-returned:
		t.Fatal("history handler returned before original cleanup joined")
	default:
	}
	close(release)
	<-returned
	incarnationRPCError(t, response, 504, "deadline_exceeded", true)
}
