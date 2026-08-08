#!/bin/sh
set -eu

# Certbot runs this only after a certificate was successfully renewed.
systemctl reload nginx
