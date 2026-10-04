FROM golang:1.27.1-bookworm AS build

WORKDIR /workspace
COPY modules/service-authentication ./modules/service-authentication
COPY services/identity-service/go.mod services/identity-service/go.sum ./services/identity-service/
RUN cd services/identity-service && go mod download

COPY services/identity-service ./services/identity-service
RUN cd services/identity-service && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/identity-service ./cmd/identity-service

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/identity-service /usr/local/bin/identity-service
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/identity-service"]
