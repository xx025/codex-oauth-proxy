package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
)

func TestInternalModeRejectsUnsignedProxyRequests(t *testing.T) {
	t.Setenv("INTERNAL_PROXY_KEY", "internal-test-key")
	srv := New(zerolog.Nop(), stubCredentialsFetcher{})

	unsigned := httptest.NewRecorder()
	srv.ServeHTTP(unsigned, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	assert.Equal(t, http.StatusUnauthorized, unsigned.Code)

	health := httptest.NewRecorder()
	srv.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	assert.Equal(t, http.StatusOK, health.Code)
}

func TestInternalModeBypassesLegacyAdminMiddleware(t *testing.T) {
	t.Setenv("INTERNAL_PROXY_KEY", "internal-test-key")
	t.Setenv("ADMIN_API_KEY", "different-admin-key")
	srv := New(zerolog.Nop(), stubCredentialsFetcher{})
	srv.mux = http.NewServeMux()
	srv.mux.HandleFunc("/v1/responses", srv.adminMiddleware(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	request.Header.Set(internalKeyHeader, "internal-test-key")
	request.Header.Set(internalTokenHeader, "oauth-access-token")
	request.Header.Set(internalAccountHeader, "chatgpt-account-id")
	recorder := httptest.NewRecorder()
	srv.ServeHTTP(recorder, request)

	assert.Equal(t, http.StatusNoContent, recorder.Code)
}

func TestConvertedStreamAlwaysUsesEventStreamContentType(t *testing.T) {
	srv := New(zerolog.Nop(), stubCredentialsFetcher{})
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader("data: [DONE]\n\n")),
	}
	recorder := httptest.NewRecorder()

	srv.writeResponse(recorder, response, http.StatusOK, "gpt-5.4-mini", true, true)

	assert.Equal(t, "text/event-stream; charset=utf-8", recorder.Header().Get("Content-Type"))
}
