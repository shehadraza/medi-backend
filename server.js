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

// ===============================
// TEST
// ===============================

app.get("/", (req, res) => {
  res.json({
    message: "MEDI Backend is running!",
  });
});

// ===============================
// AI CHAT
// ===============================

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required",
      });
    }

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
            "If symptoms are severe or an emergency, advise the user to seek immediate professional medical care. " +
            "Respond in English.",
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    const reply =
        response.choices?.[0]?.message?.content;

    if (!reply) {
      throw new Error("AI returned an empty response");
    }

    res.json({
      reply: reply,
    });
  } catch (error) {
    console.error("CHAT ERROR:", error);

    res.status(500).json({
      error: "AI response failed",
      details: error?.message || "Unknown error",
    });
  }
});

// ===============================
// PRESCRIPTION AI
// ===============================

app.post("/prescription", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: "Prescription text is required",
      });
    }

    console.log("Prescription OCR text:");
    console.log(text);

    const response =
        await client.chat.completions.create({
      model: "openai/gpt-4o",
      max_tokens: 1500,

      messages: [
        {
          role: "system",
          content: `
You are MEDI AI, a prescription information assistant.

Analyze the OCR text from a medical prescription.

For every medicine you can identify, provide:

1. Medicine name
2. What the medicine is commonly used for
3. Dosage if clearly available
4. How/when it is commonly taken if clearly available
5. Approximate medicine price in Bangladesh if you have reliable knowledge

IMPORTANT:
- Do not invent medicine names.
- Do not invent dosage.
- Do not invent prices.
- If information is uncertain, clearly say "Not available" or "Unclear".
- Do not diagnose the patient.
- Do not change the doctor's prescription.
- Tell the user to confirm medicine, dosage and price with a pharmacist/doctor.
- Return a simple, human-friendly answer.
- Do not mention that you are an AI unless necessary.
- Respond in English.

Format the answer like this:

Medicine 1:
Name: ...
Used for: ...
Dosage: ...
How to take: ...
Approximate price: ...

Medicine 2:
Name: ...
Used for: ...
Dosage: ...
How to take: ...
Approximate price: ...

At the end write:

Important:
Please verify the medicine name and dosage with a qualified doctor or pharmacist before taking it.
          `,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const result =
        response.choices?.[0]?.message?.content;

    if (!result) {
      throw new Error(
        "AI returned an empty prescription result"
      );
    }

    console.log("Prescription AI result received");

    res.json({
      result: result,
    });
  } catch (error) {
    console.error("PRESCRIPTION ERROR:");
    console.error(error);

    res.status(500).json({
      error: "Prescription analysis failed",
      details:
          error?.message ||
          "Unknown error",
    });
  }
});

// ===============================
// START SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `MEDI Backend running on port ${PORT}`
  );
});