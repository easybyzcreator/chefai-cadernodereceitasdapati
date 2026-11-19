import { GoogleGenAI } from '@google/genai';

const MODEL_NAME = 'gemini-4-hydrogen';

function getApiKey(): string {
  const raw =
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    '';
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  try {
    const apiKey = getApiKey();
    if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
      res.status(500).json({
        error: 'Chave de IA não configurada no servidor (GEMINI_API_KEY).',
      });
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { ingredients, factor } = body;
    if (!ingredients || typeof ingredients !== 'string' || typeof factor !== 'number') {
      res.status(400).json({ error: 'Parâmetros inválidos para ajuste de porções.' });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: `Você é um assistente matemático de cozinha. Multiplique todas as quantidades numéricas destes ingredientes por ${factor}. Retorne APENAS a lista de ingredientes ajustada, colocando UM ingrediente por linha (separados por quebra de linha), sem comentários extras. Ingredientes:\n${ingredients}`,
    });

    res.status(200).json({ text: response.text || '' });
  } catch (error: any) {
    console.error('Erro em /api/gemini/adjust-portions:', error);
    const rawMessage = error?.message || 'Erro ao ajustar porções com a IA.';
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (rawMessage.includes('API_KEY_INVALID')) {
      res.status(400).json({ error: 'Chave Gemini inválida nas configurações do servidor.' });
      return;
    }
    if (status === 403 || rawMessage.includes('PERMISSION_DENIED')) {
      res.status(403).json({ error: 'Permissão negada na API Gemini. Verifique a chave configurada.' });
      return;
    }
    if (status === 429 || rawMessage.includes('RESOURCE_EXHAUSTED')) {
      res.status(429).json({ error: 'Limite temporário da IA atingido. Tente novamente em instantes.' });
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: rawMessage });
  }
}
