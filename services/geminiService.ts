export class GeminiService {
  private async postJson<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error((data as { error?: string })?.error || 'Erro ao comunicar com o servidor de IA.');
    }
    return data as T;
  }

  async transcribeImage(base64Image: string) {
    return this.postJson<{
      title?: string;
      ingredients?: string;
      instructions?: string;
      category?: string;
    }>('/api/gemini/transcribe-image', {
      imageBase64: base64Image,
      mimeType: 'image/jpeg',
    });
  }

  async transcribeVideoLink(url: string) {
    return this.postJson<{
      title?: string;
      ingredients?: string;
      instructions?: string;
      category?: string;
    }>('/api/gemini/transcribe-video', { url });
  }

  async getRecipeSuggestions(ingredients: string) {
    return this.postJson<{
      title?: string;
      ingredients?: string;
      instructions?: string;
      category?: string;
    }>('/api/gemini/suggest-recipe', { ingredients });
  }

  async adjustPortions(ingredients: string, factor: number): Promise<string> {
    const data = await this.postJson<{ text?: string }>('/api/gemini/adjust-portions', {
      ingredients,
      factor,
    });
    return data.text || '';
  }
}

export const gemini = new GeminiService();
