import "dotenv/config";
import OpenAI from "openai";
import { systemPersona, askNamePrompt, replyFormat } from "./lib/prompts.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await openai.chat.completions.create({
  model: "gpt-5.1-2025-11-13",
  reasoning_effort: "none",
  temperature: 0.4,
  messages: [
    { role: "system", content: systemPersona },
    { role: "system", content: askNamePrompt },
    { role: "system", content: replyFormat },
    { role: "assistant", content: "Hi there, I can help with that. Could I get your first and last name, please?" },
    { role: "user", content: "Lisa. Lisa Chang." },
  ],
});

console.log(response.choices[0]?.message?.content ?? response);
