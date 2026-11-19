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

function parseJsonResponse(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  const cleaned = text.replace(/```json\s?|```/g, '').trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
    throw new Error('Não foi possível extrair uma receita estruturada deste link.');
  }
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
    const { url } = body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Link inválido para transcrição.' });
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
      contents: `Analise o vídeo ou post no link: ${url}. Busque informações, descrição ou referências deste conteúdo para extrair a receita fielmente. Retorne EXCLUSIVAMENTE um objeto JSON válido (sem texto antes ou depois) com os campos:
{
  "title": "nome exato da receita",
  "ingredients": "UM ingrediente por linha separado por \\n",
  "instructions": "passo a passo numerado com UM passo por linha separado por \\n",
  "category": "uma entre: entradas, saladas, prato_principal, massas, salgados, sobremesas, bebidas, pães, bolos, tortas, outros"
}`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    res.status(200).json(parseJsonResponse(response.text));
  } catch (error: any) {
    console.error('Erro em /api/gemini/transcribe-video:', error);
    const rawMessage = error?.message || 'Erro ao extrair receita do link com a IA.';
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
