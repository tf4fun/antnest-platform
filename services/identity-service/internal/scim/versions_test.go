package scim

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSCIMIfMatchParserAndOpaqueComparison(t *testing.T) {
	version := time.Unix(0, 123000).UTC()
	for _, tc := range []struct {
		name    string
		values  []string
		absent  bool
		any     bool
		tags    []string
		matches bool
	}{
		{name: "absent", absent: true, matches: true},
		{name: "empty-field", values: []string{""}},
		{name: "empty-list", values: []string{" ,\t, "}},
		{name: "wildcard", values: []string{" \t* \t"}, any: true, matches: true},
		{name: "weak", values: []string{`W/"123000"`}, tags: []string{"123000"}, matches: true},
		{name: "strong", values: []string{`"123000"`}, tags: []string{"123000"}, matches: true},
		{name: "repeated-fields", values: []string{`"old"`, ` W/"123000", "future"`}, tags: []string{"old", "123000", "future"}, matches: true},
		{name: "empty-elements", values: []string{`, W/"123000", ,`}, tags: []string{"123000"}, matches: true},
		{name: "quoted-comma", values: []string{`"a,b", "x\\y"`}, tags: []string{"a,b", `x\\y`}},
		{name: "empty-tag", values: []string{`W/""`}, tags: []string{""}},
		{name: "opaque-case", values: []string{`"OPAQUE"`}, tags: []string{"OPAQUE"}},
		{name: "leading-zero", values: []string{`"0123000"`}, tags: []string{"0123000"}},
		{name: "overflow-is-opaque", values: []string{`"9999999999999999999999999999999"`}, tags: []string{"9999999999999999999999999999999"}},
		{name: "obs-text", values: []string{"\"\x80\xff\""}, tags: []string{"\x80\xff"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			condition, err := ParseIfMatch(tc.values)
			if err != nil || (condition == nil) != tc.absent {
				t.Fatalf("condition=%#v err=%v", condition, err)
			}
			if condition != nil && (condition.Any != tc.any || !reflect.DeepEqual(condition.Tags, tc.tags)) {
				t.Fatalf("condition=%#v want any=%v tags=%#v", condition, tc.any, tc.tags)
			}
			if condition.Matches(version) != tc.matches {
				t.Fatalf("condition=%#v matches=%v want=%v", condition, condition.Matches(version), tc.matches)
			}
		})
	}
	for _, nanos := range []int64{-1000, 0, 123000} {
		instant := time.Unix(0, nanos)
		want := fmt.Sprintf(`W/"%d"`, nanos)
		if got := ResourceVersion(instant); got != want {
			t.Fatalf("version=%q want=%q", got, want)
		}
		condition, err := ParseIfMatch([]string{want})
		if err != nil || !condition.Matches(instant) || condition.Matches(instant.Add(time.Microsecond)) {
			t.Fatalf("roundtrip %q condition=%#v err=%v", want, condition, err)
		}
	}
}

func TestSCIMIfMatchParserRejectsMalformedAndExcessiveInput(t *testing.T) {
	for _, values := range [][]string{
		{`tag`}, {`w/"x"`}, {`W/ "x"`}, {`W/`}, {`"unterminated`}, {`"x"junk`}, {`"x" "y"`},
		{`* , "tag"`}, {`"tag", *`}, {`*`, `*`}, {`*,`}, {`,*`},
		{"\"space inside\""}, {"\"tab\tinside\""}, {"\"line\ninside\""}, {"\"\x7f\""},
		{"\v\"tag\""}, {"\"tag\"\r"},
		{`"` + strings.Repeat("x", 8191) + `"`},
		{`"` + strings.Repeat("x", 8190) + `"`, ""},
		{strings.Repeat(`"tag",`, 64) + `"tag"`},
		{strings.Repeat(",", 64)},
	} {
		condition, err := ParseIfMatch(values)
		if err == nil || condition != nil {
			t.Fatalf("accepted input lengths=%v condition=%#v", ifMatchValueLengths(values), condition)
		}
	}
	for _, values := range [][]string{
		{`"` + strings.Repeat("x", 8190) + `"`},
		{strings.Repeat(`"tag",`, 63) + `"tag"`},
		{strings.Repeat(",", 63)},
	} {
		if _, err := ParseIfMatch(values); err != nil {
			t.Fatalf("refused boundary lengths=%v err=%v", ifMatchValueLengths(values), err)
		}
	}
}

func ifMatchValueLengths(values []string) []int {
	lengths := make([]int, len(values))
	for index, value := range values {
		lengths[index] = len(value)
	}
	return lengths
}

func TestSCIMIfMatchReachesEveryRepositoryCommandWithoutReplacingCAS(t *testing.T) {
	for _, resource := range []string{"Users", "Groups"} {
		for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
			for _, values := range [][]string{nil, {""}, {"*"}, {`"unknown"`, ` W/"123000"`}} {
				t.Run(resource+"/"+method+"/"+fmt.Sprint(values), func(t *testing.T) {
					h, repo := versionHTTPFixture(t)
					response := versionRequest(t, h, resource, method, values)
					if response.Code < 200 || response.Code >= 300 {
						t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
					}
					var got *IfMatchCondition
					var baseline time.Time
					switch {
					case resource == "Users" && method == http.MethodDelete:
						got = repo.deletedUser.IfMatch
					case resource == "Users":
						got, baseline = repo.replacedUser.IfMatch, repo.replacedUser.ExpectedUpdatedAt
					case method == http.MethodDelete:
						got = repo.deletedGroup.IfMatch
					default:
						got, baseline = repo.replacedGroup.IfMatch, repo.replacedGroup.ExpectedUpdatedAt
					}
					want, err := ParseIfMatch(values)
					if err != nil || !reflect.DeepEqual(got, want) {
						t.Fatalf("condition=%#v want=%#v err=%v", got, want, err)
					}
					if method != http.MethodDelete && !baseline.Equal(fixedSCIMNow()) {
						t.Fatalf("internal request snapshot lost: %s", baseline)
					}
				})
			}
		}
	}
}
