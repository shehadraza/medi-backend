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

// =====================================================
// TEST
// =====================================================

app.get("/", (req, res) => {
  res.json({
    message: "MEDI Backend is running!",
  });
});

// =====================================================
// AI CHAT
// =====================================================

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

// =====================================================
// PRESCRIPTION AI ANALYSIS
// =====================================================

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

    const response = await client.chat.completions.create({
      model: "openai/gpt-4o",
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content: `
You are MEDI AI, a prescription information assistant.

The user will provide OCR text extracted from a doctor's prescription.

Your job is to identify medicines that are clearly present in the prescription and provide general information about them.

Return ONLY valid JSON.

Use exactly this structure:

{
  "medicines": [
    {
      "name": "Medicine name",
      "dosage": "Dosage",
      "purpose": "General purpose of the medicine",
      "price": "Estimated price"
    }
  ]
}

IMPORTANT RULES:

1. Do not invent medicine names.
2. Only include medicines that appear reasonably identifiable in the OCR text.
3. If a medicine name is unclear, use "Unknown" instead of guessing.
4. Do not diagnose the patient's disease.
5. "purpose" must describe the general use of the medicine.
6. Price must be an estimate only.
7. If the price is unknown, write "Price unavailable".
8. Do not provide dangerous or personalized medical instructions.
9. Do not change the prescribed dosage.
10. Keep the answer simple and easy to understand.
11. Return JSON only. Do not add markdown.
          `,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    let reply = response.choices?.[0]?.message?.content;

    if (!reply) {
      throw new Error("AI returned an empty response");
    }

    console.log("Prescription AI response:");
    console.log(reply);

    // Remove markdown code fences if AI adds them
    reply = reply
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // Check whether returned text is valid JSON
    let parsedResult;

    try {
      parsedResult = JSON.parse(reply);
    } catch (jsonError) {
      console.error("INVALID AI JSON:");
      console.error(reply);

      throw new Error(
        "AI returned an invalid prescription result"
      );
    }

    res.json({
      success: true,
      result: parsedResult,
    });
  } catch (error) {
    console.error("PRESCRIPTION AI ERROR:");
    console.error(error);
    console.error("STATUS:", error?.status);
    console.error("MESSAGE:", error?.message);

    res.status(500).json({
      success: false,
      error: "Prescription analysis failed",
      details: error?.message || "Unknown error",
    });
  }
});

// =====================================================
// SERVER
// =====================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `MEDI Backend running on port ${PORT}`
  );
});