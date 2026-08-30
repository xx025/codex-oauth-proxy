//go:build js && wasm

package main

import (
	"github.com/dvcrn/codex-oauth-proxy/internal/app"
	"github.com/dvcrn/codex-oauth-proxy/internal/auth"
	"github.com/dvcrn/codex-oauth-proxy/internal/credentials"
	"github.com/dvcrn/codex-oauth-proxy/internal/env"
	"github.com/dvcrn/codex-oauth-proxy/internal/logger"
	"github.com/syumai/workers"
)

func main() {
	// Create logger
	log := logger.New()

	if _, internalMode := env.Get("INTERNAL_PROXY_KEY"); internalMode {
		log.Info().Msg("Using request-scoped credentials from the edge coordinator")
		srv := app.NewServer(credentials.InternalOnlyFetcher{}, log)
		workers.Serve(srv)
		return
	}

	log.Info().Msg("Using Cloudflare KV credentials fetcher with OAuth refresh")
	kvFetcher, err := credentials.NewCloudflareKVFetcher()
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to create Cloudflare KV fetcher")
	}

	// Wrap with OAuth fetcher for automatic token refresh
	oauthFetcher := auth.NewOAuthFetcher(kvFetcher, &log)

	// Create server using OAuth-wrapped fetcher
	srv := app.NewServer(oauthFetcher, log)

	// Serve using workers - it handles all the HTTP server setup
	workers.Serve(srv)
}
