const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// Test
app.get("/", (req, res) => {
  res.json({
    message: "MEDI Backend is running!",
  });
});

// AI Chat
app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    console.log("User message:", message);

    const response = await client.chat.completions.create({
      model: "openai/gpt-4o",
       max_tokens: 1000,
      messages: [
        {
          role: "system",
          content:
            "You are MEDI AI, a helpful health information assistant. " +
            "Give general health information only. " +
            "Do not diagnose diseases or claim certainty about a medical condition. " +
            "Help the user understand which type of healthcare professional may be appropriate. " +
            "If symptoms are severe or an emergency, advise the user to seek immediate professional medical care. " +
            "You can respond in English, Bangla, or Banglish depending on the user's language.",
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    const reply = response.choices?.[0]?.message?.content;

    if (!reply) {
      throw new Error("AI returned an empty response");
    }

    console.log("AI reply received");

    res.json({
      reply: reply,
    });
  } catch (error) {
    console.error("OPENROUTER ERROR:");
    console.error(error);
    console.error("STATUS:", error?.status);
    console.error("MESSAGE:", error?.message);

    res.status(500).json({
      error: "AI response failed",
      details: error?.message || "Unknown AI error",
    });
  }
});

const PORT = 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MEDI Backend running on http://localhost:${PORT}`);
});