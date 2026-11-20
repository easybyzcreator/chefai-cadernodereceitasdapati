import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

dotenv.config({ path: '.env.local' });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function getGeminiClient(): GoogleGenAI {
  const raw =
    process.env.GEMINI_API_KEY ||
    process.env.API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    '';
  const apiKey = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!apiKey || apiKey === 'PLACEHOLDER_API_KEY') {
    const err = new Error(
      'Chave de IA não configurada no servidor (GEMINI_API_KEY). Configure em Settings > Secrets ou nas variáveis de ambiente do servidor.'
    ) as Error & { status?: number };
    err.status = 500;
    throw err;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function parseJsonResponse(text: string | undefined): Record<string, unknown> {
  if (!text) {
    throw new Error('A IA não retornou resposta para esta solicitação. Tente novamente.');
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
      throw new Error('Não foi possível interpretar o formato da receita retornada pela IA.');
    }
  }
  const hasContent =
    (typeof parsed.title === 'string' && parsed.title.trim().length > 0) ||
    (typeof parsed.ingredients === 'string' && parsed.ingredients.trim().length > 0) ||
    (typeof parsed.instructions === 'string' && parsed.instructions.trim().length > 0);
  if (!hasContent) {
    throw new Error('A IA não conseguiu identificar uma receita completa. Tente novamente.');
  }
  return parsed;
}

function getErrorPayload(error: unknown): { status: number; message: string } {
  const errObj = error as { status?: number; code?: number; message?: string };
  const rawMessage = errObj?.message || 'Erro ao processar solicitação com a IA.';
  const status = typeof errObj?.status === 'number'
    ? errObj.status
    : typeof errObj?.code === 'number'
      ? errObj.code
      : 500;

  if (rawMessage.includes('API_KEY_INVALID')) {
    return {
      status: 400,
      message: 'A chave Gemini configurada no servidor é inválida. Verifique GEMINI_API_KEY em Settings > Secrets.',
    };
  }
  if (status === 403 || rawMessage.includes('PERMISSION_DENIED')) {
    return { status: 403, message: 'Permissão negada na API Gemini. Verifique a chave nas configurações do servidor.' };
  }
  if (status === 429 || rawMessage.includes('RESOURCE_EXHAUSTED')) {
    return { status: 429, message: 'Limite temporário de requisições da IA atingido. Tente novamente em instantes.' };
  }
  return { status: status >= 400 && status < 600 ? status : 500, message: rawMessage };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.post('/api/gemini/transcribe-image', async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body || {};
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        res.status(400).json({ error: 'Imagem inválida para transcrição.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: {
          parts: [
            { inlineData: { data: imageBase64, mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg' } },
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

      res.json(parseJsonResponse(response.text));
    } catch (error) {
      console.error('Erro em /api/gemini/transcribe-image:', error);
      const { status, message } = getErrorPayload(error);
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/gemini/transcribe-video', async (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url || typeof url !== 'string') {
        res.status(400).json({ error: 'Link inválido para transcrição.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: `Extraia a receita completa do link: ${url}. Leia o conteúdo da página ou busque a receita correspondente. Retorne EXCLUSIVAMENTE um JSON válido com TODOS os ingredientes e TODOS os passos completos do preparo (nunca resuma nem corte com ...):
{
  "title": "nome exato da receita",
  "ingredients": "UM ingrediente por linha separado por \\n",
  "instructions": "passo a passo completo numerado com UM passo por linha separado por \\n",
  "category": "uma entre: entradas, saladas, prato_principal, carnes, massas, salgados, sobremesas, bebidas, pães, bolos, tortas, outros"
}`,
        config: {
          systemInstruction: RECIPE_SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          tools: [{ urlContext: {} }, { googleSearch: {} }],
        },
      });

      res.json(parseJsonResponse(response.text));
    } catch (error) {
      console.error('Erro em /api/gemini/transcribe-video:', error);
      const { status, message } = getErrorPayload(error);
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/gemini/suggest-recipe', async (req, res) => {
    try {
      const { ingredients } = req.body || {};
      if (!ingredients || typeof ingredients !== 'string') {
        res.status(400).json({ error: 'Informe os ingredientes para gerar uma sugestão.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: `Com base nestes ingredientes disponíveis: ${ingredients}, crie UMA receita deliciosa, completa e detalhada do início ao fim. Liste TODOS os ingredientes com medidas e TODOS os passos completos do modo de preparo (no mínimo 5 passos detalhados, sem abreviações ou reticências). Retorne em JSON: title, ingredients (UM por linha separado por \\n), instructions (UM passo numerado por linha separado por \\n) e category (entradas, saladas, prato_principal, carnes, massas, salgados, sobremesas, bebidas, pães, bolos, tortas, outros).`,
        config: {
          systemInstruction: RECIPE_SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: RECIPE_SCHEMA,
        },
      });

      res.json(parseJsonResponse(response.text));
    } catch (error) {
      console.error('Erro em /api/gemini/suggest-recipe:', error);
      const { status, message } = getErrorPayload(error);
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/gemini/adjust-portions', async (req, res) => {
    try {
      const { ingredients, factor } = req.body || {};
      if (!ingredients || typeof ingredients !== 'string' || typeof factor !== 'number') {
        res.status(400).json({ error: 'Parâmetros inválidos para ajuste de porções.' });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: `Multiplique todas as quantidades numéricas destes ingredientes por ${factor}. Retorne APENAS a lista de ingredientes ajustada, UM ingrediente por linha, sem comentários extras. Ingredientes:\n${ingredients}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      res.json({ text: response.text || '' });
    } catch (error) {
      console.error('Erro em /api/gemini/adjust-portions:', error);
      const { status, message } = getErrorPayload(error);
      res.status(status).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
