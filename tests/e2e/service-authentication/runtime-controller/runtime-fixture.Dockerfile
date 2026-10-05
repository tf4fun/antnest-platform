FROM antnest/antnest-runtime:local
COPY tests/e2e/service-authentication/runtime-controller/runtime-fixture.mjs /fixture/runtime-fixture.mjs
ENTRYPOINT ["node", "/fixture/runtime-fixture.mjs"]
