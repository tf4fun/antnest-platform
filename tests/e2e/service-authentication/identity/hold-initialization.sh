#!/bin/sh
# Keep the socket-only initialization server alive long enough to verify that
# dependency health does not admit Identity before PostgreSQL accepts TCP.
sleep 3
