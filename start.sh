#!/bin/sh
if [ "$CLUSTER_MODE" = "true" ]; then
  exec node cluster.mjs
else
  exec node server.mjs
fi