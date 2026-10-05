FROM golang:1.27.1-bookworm AS build

WORKDIR /workspace
COPY modules/service-authentication ./modules/service-authentication
COPY services/skill-registry/go.mod services/skill-registry/go.sum ./services/skill-registry/
RUN cd services/skill-registry && go mod download

COPY services/skill-registry ./services/skill-registry
RUN cd services/skill-registry && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/skill-registry ./cmd/skill-registry

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/skill-registry /usr/local/bin/skill-registry
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/skill-registry"]
