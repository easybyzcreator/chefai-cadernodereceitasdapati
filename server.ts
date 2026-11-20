import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config({ path: '.env.local' });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_NAME = 'gemini-4-hydrogen';

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
  if (!text) return {};
  const cleaned = text.replace(/```json\s?|```/g, '').trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
    throw new Error('Não foi possível interpretar o formato da receita retornada pela IA.');
  }
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
              text: 'Você é um assistente de cozinha especializado. Sua tarefa é extrair com precisão absoluta a receita desta imagem. Se for escrita à mão, use todo o seu conhecimento para decifrar as palavras. Retorne APENAS um objeto JSON estruturado com os campos: title (nome da receita), ingredients (lista detalhada com UM ingrediente por linha separado por quebra de linha \\n), instructions (passo a passo completo com UM passo numerado por linha separado por \\n) e category (escolha exclusivamente entre: entradas, saladas, prato_principal, carnes, massas, salgados, sobremesas, bebidas, pães, bolos, tortas, outros).',
            },
          ],
        },
        config: {
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
        contents: `Analise o vídeo ou post no link: ${url}. Busque informações, descrição ou referências deste conteúdo para extrair a receita fielmente. Retorne EXCLUSIVAMENTE um objeto JSON válido (sem texto antes ou depois) com os campos:
{
  "title": "nome exato da receita",
  "ingredients": "UM ingrediente por linha separado por \\n",
  "instructions": "passo a passo numerado com UM passo por linha separado por \\n",
  "category": "uma entre: entradas, saladas, prato_principal, carnes, massas, salgados, sobremesas, bebidas, pães, bolos, tortas, outros"
}`,
        config: {
          tools: [{ googleSearch: {} }],
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
        contents: `Você é um chef premiado. Com base nestes ingredientes disponíveis: ${ingredients}, crie UMA receita completa e detalhada. Seja específico nas quantidades e no modo de preparo. Retorne no formato JSON: title, ingredients (UM ingrediente por linha separado por \\n), instructions (UM passo numerado por linha separado por \\n) e category (entradas, saladas, prato_principal, carnes, massas, salgados, sobremesas, bebidas, pães, bolos, tortas, outros).`,
        config: {
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
        contents: `Você é um assistente matemático de cozinha. Multiplique todas as quantidades numéricas destes ingredientes por ${factor}. Retorne APENAS a lista de ingredientes ajustada, colocando UM ingrediente por linha (separados por quebra de linha), sem comentários extras. Ingredientes:\n${ingredients}`,
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
