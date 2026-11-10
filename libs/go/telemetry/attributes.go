package telemetry

import (
	"os"
	"sort"
	"strings"

	"go.opentelemetry.io/otel/attribute"
)

const legacyAttributesEnv = "ANTNEST_TELEMETRY_LEGACY_ATTRIBUTES"

var canonicalAliases = func() map[string][]string {
	reverse := map[string][]string{}
	for alias, canonical := range DeprecatedAliases {
		reverse[canonical] = append(reverse[canonical], alias)
	}
	for _, aliases := range reverse {
		sort.Strings(aliases)
	}
	return reverse
}()

func legacyAttributesEnabled() bool {
	value, ok := os.LookupEnv(legacyAttributesEnv)
	if !ok {
		return true
	}
	trimmed := strings.TrimSpace(value)
	return trimmed == "" || !strings.EqualFold(trimmed, "false")
}

func AliasAttributes(attrs ...attribute.KeyValue) []attribute.KeyValue {
	type group struct {
		value     attribute.Value
		canonical bool
	}
	order := []attribute.Key{}
	groups := map[attribute.Key]*group{}
	for _, attr := range attrs {
		key := attr.Key
		canonical, alias := DeprecatedAliases[string(key)]
		resolved := key
		if alias {
			resolved = attribute.Key(canonical)
		}
		entry, ok := groups[resolved]
		if !ok {
			entry = &group{}
			groups[resolved] = entry
			order = append(order, resolved)
		}
		if alias {
			if !entry.canonical {
				entry.value = attr.Value
			}
			continue
		}
		entry.value = attr.Value
		entry.canonical = true
	}
	emitLegacy := legacyAttributesEnabled()
	out := make([]attribute.KeyValue, 0, len(order))
	for _, key := range order {
		entry := groups[key]
		out = append(out, attribute.KeyValue{Key: key, Value: entry.value})
		if !emitLegacy {
			continue
		}
		for _, alias := range canonicalAliases[string(key)] {
			out = append(out, attribute.KeyValue{
				Key:   attribute.Key(alias),
				Value: entry.value,
			})
		}
	}
	return out
}

func MetricAttributes(attrs ...attribute.KeyValue) []attribute.KeyValue {
	normalized := AliasAttributes(attrs...)
	out := make([]attribute.KeyValue, 0, len(normalized))
	for _, attr := range normalized {
		if RestrictedMetricAttributes[string(attr.Key)] {
			continue
		}
		out = append(out, attr)
	}
	return out
}
