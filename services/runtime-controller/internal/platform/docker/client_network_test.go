package docker

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestHTTPClientInspectsNetworkIPAMDetails(t *testing.T) {
	var path string
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		path = request.URL.Path
		if path == "/v1.47/networks/missing" {
			return jsonResponse(http.StatusNotFound, map[string]string{"message": "network missing not found"}), nil
		}
		return jsonResponse(http.StatusOK, map[string]any{
			"Name": "antnest-runtime-management",
			"IPAM": map[string]any{
				"Driver": "default",
				"Config": []map[string]any{{
					"Subnet":             "172.30.255.0/24",
					"IPRange":            "172.30.255.0/25",
					"Gateway":            "172.30.255.1",
					"AuxiliaryAddresses": map[string]string{"egress": "172.30.255.3"},
				}},
			},
			"Containers": map[string]any{
				"container-1": map[string]any{"IPv4Address": "172.30.255.10/24"},
				"container-2": map[string]any{"IPv4Address": "172.30.255.11/24"},
			},
		}), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	network, err := client.InspectNetworkDetails(context.Background(), "antnest-runtime-management")
	if err != nil {
		t.Fatal(err)
	}
	if path != "/v1.47/networks/antnest-runtime-management" {
		t.Fatalf("wrong network path: %s", path)
	}
	if network.Name != "antnest-runtime-management" || len(network.IPAM) != 1 {
		t.Fatalf("network identity missing: %+v", network)
	}
	config := network.IPAM[0]
	if config.Subnet != "172.30.255.0/24" || config.IPRange != "172.30.255.0/25" ||
		config.Gateway != "172.30.255.1" || config.AuxiliaryAddresses["egress"] != "172.30.255.3" {
		t.Fatalf("IPAM details were not mapped: %+v", config)
	}
	if network.Containers["container-1"] != "172.30.255.10/24" || network.Containers["container-2"] != "172.30.255.11/24" {
		t.Fatalf("attached endpoints were not mapped: %+v", network.Containers)
	}
	if _, err := client.InspectNetworkDetails(context.Background(), "missing"); err == nil {
		t.Fatal("missing network did not fail")
	}
}

func TestHTTPClientRenamesContainerByID(t *testing.T) {
	var method, path, query string
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		method, path = request.Method, request.URL.Path
		query = request.URL.Query().Get("name")
		if strings.Contains(request.URL.Path, "rename") && query == "antnest-scope-runtime-agent-1" {
			return responseWith(http.StatusNoContent, ""), nil
		}
		return jsonResponse(http.StatusConflict, map[string]string{"message": "name already in use"}), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.RenameContainer(context.Background(), "container-1", "antnest-scope-runtime-agent-1"); err != nil {
		t.Fatal(err)
	}
	if method != http.MethodPost || path != "/v1.47/containers/container-1/rename" || query != "antnest-scope-runtime-agent-1" {
		t.Fatalf("rename request: %s %s name=%s", method, path, query)
	}
	if err := client.RenameContainer(context.Background(), "container-2", "taken"); !errors.Is(err, ErrConflict) {
		t.Fatalf("rename conflict: %v", err)
	}
}

func TestIPAMExhaustionOnlyMatchesKnownDockerMessages(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  int
		message string
		want    bool
	}{
		{"address pools exhausted", 500, "no available IPv4 addresses on this network's address pools: antnest-runtime-management (0123abcd)", true},
		{"conflict pool exhausted", 409, "no available IPv4 addresses on this network's address pools: x", true},
		{"generic daemon failure", 500, "driver failed programming external connectivity", false},
		{"not found with pool text", 404, "no available IPv4 addresses on this network's address pools: x", false},
		{"forbidden with pool text", 403, "no available IPv4 addresses on this network's address pools: x", false},
		{"name conflict", 409, "Conflict. The container name is already in use", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return jsonResponse(test.status, map[string]string{"message": test.message}), nil
			})
			client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.CreateContainer(context.Background(), ContainerSpec{Name: "x", Image: "i"})
			if err == nil {
				t.Fatal("create succeeded")
			}
			if got := isIPAMExhaustion(err); got != test.want {
				t.Fatalf("exhaustion classification = %t want %t for %v", got, test.want, err)
			}
		})
	}
	if got := isIPAMExhaustion(errors.New("no available IPv4 addresses on this network's address pools: transport")); got {
		t.Fatal("a transport-layer error string was classified as IPAM exhaustion")
	}
}
