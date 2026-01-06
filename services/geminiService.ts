
import { GoogleGenAI, Type } from "@google/genai";

const getAi = () => new GoogleGenAI({ apiKey: process.env.API_KEY as string });

export const analyzeConflicts = async (content: string) => {
  if (!process.env.API_KEY) throw new Error("Missing API Key");
  const ai = getAi();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Analyze these legal statements for contradictions and truth gaps. 
    Return a JSON array of conflict objects. Content: ${content}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            statementA: { type: Type.STRING },
            statementB: { type: Type.STRING },
            analysis: { type: Type.STRING },
            severity: { type: Type.STRING, enum: ['high', 'medium', 'low'] }
          },
          required: ["id", "statementA", "statementB", "analysis", "severity"]
        }
      }
    }
  });
  return JSON.parse(response.text || '[]');
};

export const analyzeDocketProgress = async (docketText: string, currentPrep: string) => {
  if (!process.env.API_KEY) throw new Error("Missing API Key");
  const ai = getAi();
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: `Docket: ${docketText}\n\nCurrent Evidence/Prep: ${currentPrep}\n\n
    Analyze the readiness (0-100%) for filing. List missing items to reach 100%.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          percentComplete: { type: Type.NUMBER },
          requiredActions: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING } 
          },
          currentStage: { type: Type.STRING }
        },
        required: ["percentComplete", "requiredActions", "currentStage"]
      }
    }
  });
  return JSON.parse(response.text || '{}');
};

export const chatWithSearch = async (query: string, history: {role: string, parts: {text: string}[]}[]) => {
  if (!process.env.API_KEY) throw new Error("Missing API Key");
  const ai = getAi();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: [...history, { role: 'user', parts: [{ text: query }] }],
    config: {
      tools: [{ googleSearch: {} }]
    }
  });
  
  const urls = response.candidates?.[0]?.groundingMetadata?.groundingChunks
    ?.map((chunk: any) => chunk.web)
    .filter(Boolean) || [];

  return { text: response.text, urls };
};
