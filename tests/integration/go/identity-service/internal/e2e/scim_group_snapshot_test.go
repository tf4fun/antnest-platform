package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestSCIMGroupReadVersionAndMembersShareOneSnapshot(t *testing.T) {
	for _, list := range []bool{false, true} {
		name := "single"
		if list {
			name = "list"
		}
		t.Run(name, func(t *testing.T) {
			f := newSCIMVersionFixture(t)
			beforeVersion := scim.ResourceVersion(f.group.Group.UpdatedAt)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			readingMembers, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			reader := tracedSCIMPairing(t, f.bindingFixture, func(ctx context.Context, _ *pgx.Conn, sql string) {
				if strings.Contains(sql, "FROM group_memberships") {
					once.Do(func() {
						close(readingMembers)
						select {
						case <-release:
						case <-ctx.Done():
						}
					})
				}
			})
			handler, err := scim.NewHTTPHandler(reader, "https://identity.example.com")
			if err != nil {
				t.Fatal(err)
			}
			path := "/scim/v2/Groups"
			if !list {
				path += "/" + f.group.Group.ID
			}
			request := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
			request.Header.Set("Authorization", "Bearer "+f.credential)
			response := httptest.NewRecorder()
			done := make(chan struct{})
			workers.Go(func() { handler.ServeHTTP(response, request); close(done) })
			select {
			case <-readingMembers:
			case <-done:
				t.Fatal("read completed without the membership snapshot barrier")
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			changed, err := f.service.ReplaceGroup(ctx, f.auth, f.group.Group.ID, scim.ReplaceGroupInput{
				GroupInput:        scim.GroupInput{DisplayName: "Updated snapshot", MemberIDs: nil},
				ExpectedUpdatedAt: f.group.Group.UpdatedAt,
			})
			if err != nil {
				t.Fatal(err)
			}
			afterVersion := scim.ResourceVersion(changed.Group.UpdatedAt)
			if afterVersion == beforeVersion {
				t.Fatal("concurrent write did not advance the version")
			}
			close(release)
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if response.Code != http.StatusOK {
				t.Fatalf("read status=%d body=%s", response.Code, response.Body.String())
			}
			type groupResponse struct {
				ID          string
				DisplayName string
				Members     []struct{ Value string }
				Meta        struct{ Version string }
			}
			var resource groupResponse
			if list {
				var page struct{ Resources []groupResponse }
				if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || len(page.Resources) != 1 {
					t.Fatalf("invalid group page: %v %s", err, response.Body.String())
				}
				resource = page.Resources[0]
			} else {
				if err := json.Unmarshal(response.Body.Bytes(), &resource); err != nil {
					t.Fatal(err)
				}
				if response.Header().Get("ETag") != resource.Meta.Version {
					t.Fatal("header and representation versions differ")
				}
			}
			oldSnapshot := resource.Meta.Version == beforeVersion && resource.DisplayName == f.group.Group.DisplayName &&
				len(resource.Members) == 1 && resource.Members[0].Value == f.user.Membership.ID
			newSnapshot := resource.Meta.Version == afterVersion && resource.DisplayName == "Updated snapshot" && len(resource.Members) == 0
			if resource.ID != f.group.Group.ID || (!oldSnapshot && !newSnapshot) {
				t.Fatalf("Group mixes committed versions: before=%s after=%s body=%s", beforeVersion, afterVersion, response.Body.String())
			}
		})
	}
}
