export class GeminiService {
  private async postJson<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        if (response.status === 504) {
          throw new Error('A IA demorou mais que o esperado. Tente novamente em instantes.');
        }
        throw new Error('Servidor de IA indisponível neste endereço. Verifique as rotas /api e a chave GEMINI_API_KEY.');
      }

      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        throw new Error((data as { error?: string } | null)?.error || 'Erro ao comunicar com o servidor de IA.');
      }
      return data as T;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new Error('A solicitação para a IA demorou demais. Tente novamente.');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async transcribeImage(base64Image: string, mimeType = 'image/jpeg') {
    return this.postJson<{
      title?: string;
      ingredients?: string;
      instructions?: string;
      category?: string;
    }>('/api/gemini/transcribe-image', {
      imageBase64: base64Image,
      mimeType,
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
