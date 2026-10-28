package server

import (
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func (request *createTemplateRequest) UnmarshalJSON(data []byte) error {
	type wireRequest createTemplateRequest
	var wire wireRequest
	if err := serviceauth.DecodeObject(data, &wire); err != nil {
		return err
	}
	if err := domain.ValidateModelPolicyJSON(data); err != nil {
		return err
	}
	*request = createTemplateRequest(wire)
	return nil
}

func (request *reviseTemplateRequest) UnmarshalJSON(data []byte) error {
	type wireRequest reviseTemplateRequest
	var wire wireRequest
	if err := serviceauth.DecodeObject(data, &wire); err != nil {
		return err
	}
	if err := domain.ValidateModelPolicyJSON(data); err != nil {
		return err
	}
	*request = reviseTemplateRequest(wire)
	return nil
}
