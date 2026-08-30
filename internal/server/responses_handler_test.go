package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const responsesSSEFixture = `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}}

data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5.6-sol","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}

`

type responsesHTTPClient struct {
	requestBody map[string]interface{}
}

func (client *responsesHTTPClient) Do(request *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, &client.requestBody); err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(responsesSSEFixture)),
	}, nil
}

func TestResponsesHandlerBuffersNonStreamingRequests(t *testing.T) {
	upstream := &responsesHTTPClient{}
	server := New(zerolog.Nop(), stubCredentialsFetcher{})
	server.httpClient = upstream
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5.6-sol","input":"Reply with exactly: OK","stream":false}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.responsesHandler(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "application/json", recorder.Header().Get("Content-Type"))
	assert.Equal(t, true, upstream.requestBody["stream"])
	input, ok := upstream.requestBody["input"].([]interface{})
	require.True(t, ok)
	require.Len(t, input, 1)

	var response map[string]interface{}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	output, ok := response["output"].([]interface{})
	require.True(t, ok)
	require.Len(t, output, 1)
	assert.Equal(t, "completed", response["status"])
}

func TestResponsesHandlerForcesEventStreamContentType(t *testing.T) {
	upstream := &responsesHTTPClient{}
	server := New(zerolog.Nop(), stubCredentialsFetcher{})
	server.httpClient = upstream
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"gpt-5.6-sol","input":"Reply with exactly: OK","stream":true}`))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.responsesHandler(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "text/event-stream; charset=utf-8", recorder.Header().Get("Content-Type"))
	assert.Contains(t, recorder.Body.String(), `"type":"response.completed"`)
}
