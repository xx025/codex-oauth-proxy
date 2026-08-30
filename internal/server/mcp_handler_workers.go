//go:build js && wasm

package server

import "net/http"

func (s *Server) mcpHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "MCP is not available in the Cloudflare build", http.StatusNotImplemented)
	}
}
