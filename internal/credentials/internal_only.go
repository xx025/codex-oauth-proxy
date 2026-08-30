package credentials

import "errors"

type InternalOnlyFetcher struct{}

func (InternalOnlyFetcher) GetCredentials() (string, string, error) {
	return "", "", errors.New("request-scoped credentials required")
}

func (InternalOnlyFetcher) RefreshCredentials() error {
	return errors.New("request-scoped credentials cannot be refreshed by the core worker")
}
