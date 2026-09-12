package domain

// ModelParameters excludes connection and authentication configuration.
type ModelParameters struct {
	Pricing         *ModelPricing `json:"pricing,omitempty"`
	Model           string        `json:"model"`
	ContextWindow   int           `json:"context_window"`
	MaxOutputTokens int           `json:"max_output_tokens"`
	Temperature     *float64      `json:"temperature,omitempty"`
	SupportsImages  bool          `json:"supports_images"`
	SupportsAudio   bool          `json:"supports_audio,omitempty"`
	SupportsPDF     bool          `json:"supports_pdf,omitempty"`
}

func (model ModelSpec) Parameters() ModelParameters {
	model = model.Clone()
	return ModelParameters{
		Pricing: model.Pricing, Model: model.Model, ContextWindow: model.ContextWindow,
		MaxOutputTokens: model.MaxOutputTokens, Temperature: model.Temperature,
		SupportsImages: model.SupportsImages, SupportsAudio: model.SupportsAudio, SupportsPDF: model.SupportsPDF,
	}
}

func (parameters ModelParameters) WithEndpoint(endpoint string) ModelSpec {
	return (ModelSpec{
		BaseURL: endpoint, Pricing: parameters.Pricing, Model: parameters.Model, ContextWindow: parameters.ContextWindow,
		MaxOutputTokens: parameters.MaxOutputTokens, Temperature: parameters.Temperature,
		SupportsImages: parameters.SupportsImages, SupportsAudio: parameters.SupportsAudio, SupportsPDF: parameters.SupportsPDF,
	}).Clone()
}
