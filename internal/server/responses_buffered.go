package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

func bufferResponsesFromSSE(body io.Reader) (map[string]interface{}, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

	var dataLines [][]byte
	var completedResponse map[string]interface{}
	outputItems := map[int]interface{}{}

	flushEvent := func() error {
		if len(dataLines) == 0 {
			return nil
		}
		raw := bytes.Join(dataLines, []byte("\n"))
		dataLines = dataLines[:0]
		if bytes.Equal(bytes.TrimSpace(raw), []byte("[DONE]")) {
			return nil
		}

		var event map[string]interface{}
		if err := json.Unmarshal(raw, &event); err != nil {
			return fmt.Errorf("failed to decode Responses SSE event: %w", err)
		}
		eventType, _ := event["type"].(string)
		switch eventType {
		case "response.output_item.done":
			index, indexOK := event["output_index"].(float64)
			item, itemOK := event["item"]
			if indexOK && itemOK {
				outputItems[int(index)] = item
			}
		case "response.completed", "response.incomplete", "response.failed":
			if response, ok := event["response"].(map[string]interface{}); ok {
				completedResponse = response
			}
		case "error":
			message := "upstream Responses stream returned an error"
			if errorObject, ok := event["error"].(map[string]interface{}); ok {
				if upstreamMessage, ok := errorObject["message"].(string); ok && upstreamMessage != "" {
					message = upstreamMessage
				}
			}
			return fmt.Errorf("%s", message)
		}
		return nil
	}

	for scanner.Scan() {
		line := scanner.Bytes()
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			if err := flushEvent(); err != nil {
				return nil, err
			}
			continue
		}
		if bytes.HasPrefix(trimmed, []byte(":")) {
			continue
		}
		if bytes.HasPrefix(trimmed, []byte("data:")) {
			payload := bytes.TrimPrefix(trimmed, []byte("data:"))
			if len(payload) > 0 && payload[0] == ' ' {
				payload = payload[1:]
			}
			dataLines = append(dataLines, bytes.Clone(payload))
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error scanning Responses SSE stream: %w", err)
	}
	if err := flushEvent(); err != nil {
		return nil, err
	}
	if completedResponse == nil {
		return nil, fmt.Errorf("Responses SSE stream ended without a terminal response")
	}

	if len(outputItems) > 0 {
		maxIndex := 0
		for index := range outputItems {
			if index > maxIndex {
				maxIndex = index
			}
		}
		output := make([]interface{}, 0, len(outputItems))
		for index := 0; index <= maxIndex; index++ {
			if item, ok := outputItems[index]; ok {
				output = append(output, item)
			}
		}
		completedResponse["output"] = output
	}

	return completedResponse, nil
}
