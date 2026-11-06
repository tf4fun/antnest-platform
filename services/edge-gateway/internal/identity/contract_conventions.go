package identity

import (
	"bytes"
	"encoding/json"
	"fmt"
)

func nullableCursor(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func primaryPageCursor(raw json.RawMessage, after, last string) (string, error) {
	if len(raw) == 0 {
		return "", fmt.Errorf("identity returned invalid primary cursor")
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", nil
	}
	return externalIdentityCursor(raw, after, last)
}

func (page SessionPage) MarshalJSON() ([]byte, error) {
	items := page.Sessions
	if items == nil {
		items = []BrowserSession{}
	}
	return json.Marshal(struct {
		Items      []BrowserSession `json:"items"`
		NextCursor *string          `json:"next_cursor"`
	}{Items: items, NextCursor: nullableCursor(page.NextAfterID)})
}

func (page ExternalIdentityPage) MarshalJSON() ([]byte, error) {
	items := page.Bindings
	if items == nil {
		items = []ExternalIdentity{}
	}
	notices := page.Notices
	if notices == nil {
		notices = []ExternalIdentityNotice{}
	}
	return json.Marshal(struct {
		Items             []ExternalIdentity       `json:"items"`
		NextCursor        *string                  `json:"next_cursor"`
		Notices           []ExternalIdentityNotice `json:"notices"`
		NextNoticeAfterID string                   `json:"next_notice_after_id,omitempty"`
	}{Items: items, NextCursor: nullableCursor(page.NextAfterID), Notices: notices, NextNoticeAfterID: page.NextNoticeAfterID})
}
