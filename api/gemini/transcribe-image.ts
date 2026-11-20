import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const MODEL_NAME = 'gemini-4-hydrogen';

const RECIPE_SYSTEM_INSTRUCTION =
  'Você é uma chef brasileira prática e objetiva. Retorne sempre receitas completas em português do Brasil, com TODOS os ingredientes (com quantidades) e TODOS os passos completos do modo de preparo do início ao fim. Nunca use abreviações, nunca corte o texto com reticências (...), e nunca inclua notas internas ou comentários fora dos campos da receita.';

const RECIPE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    ingredients: { type: Type.STRING },
    instructions: { type: Type.STRING },
    category: { type: Type.STRING },
  },
  required: ['title', 'ingredients', 'instructions', 'category'],
};

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
  if (!text) {
    throw new Error('A IA não retornou resposta para esta imagem. Tente novamente.');
  }
  const cleaned = text.replace(/```json\s?|```/g, '').trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]) as Record<string, unknown>;
    } else {
      throw new Error('Não foi possível interpretar o formato da receita gerada pela IA.');
    }
  }
  const hasContent =
    (typeof parsed.title === 'string' && parsed.title.trim().length > 0) ||
    (typeof parsed.ingredients === 'string' && parsed.ingredients.trim().length > 0) ||
    (typeof parsed.instructions === 'string' && parsed.instructions.trim().length > 0);
  if (!hasContent) {
    throw new Error('A IA não conseguiu identificar uma receita nesta imagem.');
  }
  return parsed;
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
    const { imageBase64, mimeType } = body;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      res.status(400).json({ error: 'Imagem inválida para transcrição.' });
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
      contents: {
        parts: [
          {
            inlineData: {
              data: imageBase64,
              mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg',
            },
          },
          {
            text: 'Extraia toda a receita desta imagem (mesmo que escrita à mão) sem omitir nenhum ingrediente ou passo. Retorne APENAS JSON válido com: title, ingredients (UM ingrediente por linha separado por \\n), instructions (passo a passo COMPLETO numerado, UM passo por linha separado por \\n) e category (entradas, saladas, prato_principal, carnes, massas, salgados, sobremesas, bebidas, pães, bolos, tortas, outros).',
          },
        ],
      },
      config: {
        systemInstruction: RECIPE_SYSTEM_INSTRUCTION,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: RECIPE_SCHEMA,
      },
    });

    res.status(200).json(parseJsonResponse(response.text));
  } catch (error: any) {
    console.error('Erro em /api/gemini/transcribe-image:', error);
    const rawMessage = error?.message || 'Erro ao transcrever imagem com a IA.';
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
