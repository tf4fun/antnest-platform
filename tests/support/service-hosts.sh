# shellcheck shell=sh
# Each service listens on one private address, but Docker DNS may answer a
# multi-network client with the service's address on another shared network.
# Test clients therefore pin service names to the listeners in compose.yaml.
service_prefix=${ANTNEST_SERVICE_NETWORK_PREFIX:-10.241.0}
service_hosts="--add-host=admin-console:$service_prefix.3"
service_hosts="$service_hosts --add-host=agent-acp-service:$service_prefix.5"
service_hosts="$service_hosts --add-host=agent-controller:$service_prefix.18"
service_hosts="$service_hosts --add-host=agent-acp-control:$service_prefix.34"
service_hosts="$service_hosts --add-host=runtime-controller:$service_prefix.50"
service_hosts="$service_hosts --add-host=identity-service:$service_prefix.66"
service_hosts="$service_hosts --add-host=skill-registry:$service_prefix.82"
service_hosts="$service_hosts --add-host=edge-gateway:$service_prefix.130"
