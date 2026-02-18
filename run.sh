#!/usr/bin/env bash
cd "$(dirname "$0")"
node --env-file=.env dist/index.js
