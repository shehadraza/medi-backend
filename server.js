const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const dotenv = require("dotenv");

dotenv.config({
  path: path.join(__dirname, ".env"),
});

const app = express();

// =====================================================
// CONFIG
// =====================================================

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

const BD_API = "https://bdapis.com/api/v1.2";

const OVERPASS_URL =
  "https://overpass-api.de/api/interpreter";

const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org/search";

const APP_USER_AGENT =
  "MediHealthApp/1.0 (+https://medi-backend-q02c.onrender.com)";

const DOCTORS_FILE = path.join(
  __dirname,
  "data",
  "doctors.json"
);

// Optional DGHS configuration.
const DGHS_BASE_URL =
  process.env.DGHS_BASE_URL ||
  "https://hrm.dghs.gov.bd/api/1.0";

const DGHS_X_AUTH_TOKEN =
  process.env.DGHS_X_AUTH_TOKEN || "";

const DGHS_CLIENT_ID =
  process.env.DGHS_CLIENT_ID || "";

// Gemini retry settings
const GEMINI_MAX_RETRIES = 3;
const GEMINI_RETRY_DELAY = 2000;

// =====================================================
// APP
// =====================================================

app.use(cors());

app.use(
  express.json({
    limit: "2mb",
  })
);

// =====================================================
// GEMINI
// =====================================================

let gemini = null;

if (GEMINI_API_KEY) {
  gemini = new GoogleGenAI({
    apiKey: GEMINI_API_KEY,
  });
} else {
  console.warn(
    "WARNING: GEMINI_API_KEY is not configured."
  );
}

console.log(`Gemini model: ${GEMINI_MODEL}`);

// =====================================================
// SIMPLE CACHE
// =====================================================

const cache = new Map();

function getCache(key) {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data, minutes = 30) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + minutes * 60 * 1000,
  });
}

// =====================================================
// HELPERS
// =====================================================

function clean(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
}

function parseCoordinates(value) {
  if (!value) {
    return null;
  }

  const parts = String(value)
    .split(",")
    .map((item) => Number(item.trim()));

  if (parts.length !== 2) {
    return null;
  }

  if (
    !Number.isFinite(parts[0]) ||
    !Number.isFinite(parts[1])
  ) {
    return null;
  }

  return {
    lat: parts[0],
    lon: parts[1],
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =====================================================
// GEMINI ERROR HELPERS
// =====================================================

function getErrorStatus(error) {
  return (
    error?.status ||
    error?.code ||
    error?.response?.status ||
    null
  );
}

function isRetryableGeminiError(error) {
  const status = getErrorStatus(error);
  const message = error?.message || "";

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.toLowerCase().includes("high demand") ||
    message.toLowerCase().includes("temporarily unavailable")
  );
}

// =====================================================
// GEMINI GENERATOR
// =====================================================

async function generateGeminiContent({
  contents,
  systemInstruction,
  maxOutputTokens = 1000,
}) {
  if (!gemini) {
    throw new Error(
      "Gemini API key is not configured"
    );
  }

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= GEMINI_MAX_RETRIES;
    attempt++
  ) {
    try {
      console.log(
        `Gemini request attempt ${attempt}/${GEMINI_MAX_RETRIES}`
      );

      const response = await gemini.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: {
          systemInstruction,
          maxOutputTokens,
        },
      });

      const text = response.text?.trim();

      if (!text) {
        throw new Error(
          "Gemini returned an empty response"
        );
      }

      return text;
    } catch (error) {
      lastError = error;

      console.error(
        `Gemini attempt ${attempt} failed:`,
        error?.message || error
      );

      const shouldRetry =
        isRetryableGeminiError(error);

      if (
        !shouldRetry ||
        attempt >= GEMINI_MAX_RETRIES
      ) {
        break;
      }

      const delay = GEMINI_RETRY_DELAY * attempt;

      console.log(
        `Retrying Gemini in ${delay}ms...`
      );

      await sleep(delay);
    }
  }

  throw (
    lastError ||
    new Error("Gemini request failed")
  );
}

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "MEDI Backend is running!",
    gemini: GEMINI_API_KEY
      ? "configured"
      : "not configured",
    model: GEMINI_MODEL,
  });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    server: "MEDI Backend",
    geminiConfigured: Boolean(GEMINI_API_KEY),
    geminiModel: GEMINI_MODEL,
    hospitalSources: ["OpenStreetMap"],
    dghsConfigured: Boolean(
      DGHS_X_AUTH_TOKEN && DGHS_CLIENT_ID
    ),
    time: new Date().toISOString(),
  });
});

// =====================================================
// LOCAL MEDICAL KNOWLEDGE ENGINE
// =====================================================

function getLocalMedicalReply(rawMessage) {
  const message = clean(rawMessage);
  const text = message.toLowerCase();
  const isBangla = /[\u0980-\u09FF]/.test(message);

  const reply = (bn, en) =>
    isBangla ? bn : en;

  // Emergency warning signs must be handled first.
  const emergencyPattern =
    /(chest pain|pressure in (my )?chest|difficulty breathing|can't breathe|cannot breathe|shortness of breath|unconscious|not waking|seizure|fits|stroke|face droop|slurred speech|severe bleeding|overdose|suicid|বুকে ব্যথা|বুকে চাপ|শ্বাস নিতে কষ্ট|শ্বাসকষ্ট|অজ্ঞান|খিঁচুনি|স্ট্রোক|কথা জড়িয়ে|প্রচুর রক্তপাত|বিষ খেয়েছি|ওভারডোজ)/i;

  if (emergencyPattern.test(message)) {
    return reply(
      "আপনার বলা লক্ষণগুলো জরুরি অবস্থার ইঙ্গিত হতে পারে। দেরি না করে নিকটস্থ হাসপাতালের জরুরি বিভাগে যান বা স্থানীয় জরুরি সেবায় যোগাযোগ করুন। সম্ভব হলে কাউকে সঙ্গে নিন। অনলাইনে উত্তরের জন্য অপেক্ষা করবেন না।",
      "These symptoms may indicate a medical emergency. Seek emergency medical care now or contact your local emergency service. If possible, have someone stay with you. Do not wait for an online response."
    );
  }

  // Greetings
  if (
    /^(hi|hello|hey|হাই|হ্যালো|আসসালামু আলাইকুম|সালাম)[!. ]*$/i.test(
      text
    )
  ) {
    return reply(
      "ওয়ালাইকুম আসসালাম! আমি MEDI, সাধারণ স্বাস্থ্যতথ্য বুঝতে সাহায্য করতে পারি। আপনার কী সমস্যা হচ্ছে? বয়স, কতক্ষণ ধরে হচ্ছে এবং অন্য কোনো লক্ষণ থাকলে জানান।",
      "Hello! I am MEDI. I can help explain general health information. What symptoms are you experiencing? Please share your age, how long this has been happening, and any other symptoms."
    );
  }

  // Fever
  if (/(fever|temperature|জ্বর|গা গরম)/i.test(text)) {
    return reply(
      "জ্বর হলে বিশ্রাম নিন, পর্যাপ্ত পানি/তরল পান করুন এবং সম্ভব হলে থার্মোমিটার দিয়ে তাপমাত্রা মাপুন। জ্বরের সঙ্গে শ্বাসকষ্ট, বিভ্রান্তি, ঘাড় শক্ত হওয়া, খিঁচুনি, তীব্র ব্যথা বা পানিশূন্যতা থাকলে জরুরি চিকিৎসা নিন। জ্বর ৩ দিনের বেশি থাকলে, খুব বেশি হলে, অথবা শিশু/গর্ভবতী/বয়স্ক ব্যক্তির হলে চিকিৎসকের সঙ্গে যোগাযোগ করুন। আপনার বয়স, তাপমাত্রা এবং কতদিন ধরে জ্বর তা জানালে সাধারণ তথ্য দিতে পারি।",
      "For fever, rest, drink enough fluids, and measure your temperature with a thermometer if available. Seek urgent care for breathing difficulty, confusion, a stiff neck, seizure, severe pain, or dehydration. Contact a clinician if fever lasts more than 3 days, is very high, or affects an infant, pregnant person, or older adult. Share your age, measured temperature, and duration for more general guidance."
    );
  }

  // Diarrhea
  if (
    /(diarrh?ea|loose motion|পাতলা পায়খানা|ডায়রিয়া|ডায়রিয়া|বারবার পায়খানা)/i.test(
      text
    )
  ) {
    return reply(
      "পাতলা পায়খানায় ORS প্যাকেটের নির্দেশনা অনুযায়ী নিরাপদ পানিতে গুলে অল্প অল্প করে বারবার পান করুন এবং তরল খাবার চালিয়ে যান। প্রস্রাব কমে যাওয়া, খুব দুর্বল/ঝিমুনি, রক্তমিশ্রিত পায়খানা, তীব্র পেটব্যথা বা পানি পান করতে না পারলে দ্রুত চিকিৎসা নিন। শিশু হলে দ্রুত চিকিৎসকের পরামর্শ নিন। নিজের থেকে অ্যান্টিবায়োটিক খাবেন না।",
      "For diarrhea, take oral rehydration solution (ORS) mixed exactly as directed on the packet, in frequent small sips, and continue fluids. Seek medical care promptly for reduced urination, marked weakness or drowsiness, blood in stool, severe abdominal pain, or inability to drink. Children should be assessed promptly. Do not start antibiotics on your own."
    );
  }

  // Vomiting
  if (
    /(vomit|vomiting|throwing up|বমি|বমি হচ্ছে)/i.test(
      text
    )
  ) {
    return reply(
      "বমি হলে অল্প অল্প করে বারবার পানি বা ORS পান করার চেষ্টা করুন। একসঙ্গে বেশি পান করবেন না। রক্তবমি, তীব্র পেটব্যথা, অজ্ঞানভাব, প্রস্রাব কমে যাওয়া বা কোনো তরলই রাখতে না পারলে দ্রুত চিকিৎসা নিন। বমি বারবার হলে বা দীর্ঘস্থায়ী হলে চিকিৎসকের পরামর্শ নিন।",
      "If you are vomiting, try frequent small sips of water or ORS rather than drinking a lot at once. Seek urgent care for blood in vomit, severe abdominal pain, faintness, reduced urination, or inability to keep fluids down. Contact a clinician if vomiting is repeated or persistent."
    );
  }

  // Headache
  if (
    /(headache|মাথা ব্যথা|মাথাব্যথা|মাথা ধরেছে)/i.test(
      text
    )
  ) {
    return reply(
      "মাথাব্যথার জন্য পানি পান, বিশ্রাম এবং শান্ত পরিবেশে থাকা সহায়ক হতে পারে। হঠাৎ জীবনের সবচেয়ে তীব্র মাথাব্যথা, মাথায় আঘাতের পর ব্যথা, জ্বরের সঙ্গে ঘাড় শক্ত হওয়া, দুর্বলতা/কথা জড়িয়ে যাওয়া বা দৃষ্টির পরিবর্তন হলে জরুরি চিকিৎসা নিন। বারবার হলে বা না কমলে চিকিৎসকের পরামর্শ নিন।",
      "Hydration, rest, and a quiet environment may help with a headache. Seek emergency care for a sudden, extremely severe headache, headache after a head injury, fever with a stiff neck, weakness or slurred speech, or vision changes. Consult a clinician if it recurs or does not improve."
    );
  }

  // Cough and cold
  if (
    /(cough|cold|sore throat|runny nose|কাশি|সর্দি|গলা ব্যথা)/i.test(
      text
    )
  ) {
    return reply(
      "কাশি/সর্দিতে বিশ্রাম, পর্যাপ্ত তরল এবং ধোঁয়া এড়িয়ে চলা সহায়ক হতে পারে। ১ বছরের কম শিশুকে মধু দেবেন না। শ্বাসকষ্ট, বুকে ব্যথা, ঠোঁট নীলচে হওয়া, রক্তসহ কাশি বা দ্রুত অবনতি হলে জরুরি চিকিৎসা নিন। লক্ষণ দীর্ঘস্থায়ী হলে বা জ্বর বাড়লে চিকিৎসকের পরামর্শ নিন।",
      "For cough or cold symptoms, rest, drink fluids, and avoid smoke. Never give honey to a child under 1 year. Seek urgent care for breathing difficulty, chest pain, bluish lips, coughing blood, or rapid worsening. Contact a clinician if symptoms persist or fever worsens."
    );
  }

  // Stomach pain
  if (
    /(stomach pain|abdominal pain|belly pain|পেট ব্যথা|পেটে ব্যথা|পেটব্যথা)/i.test(
      text
    )
  ) {
    return reply(
      "পেটব্যথার কারণ অনেক রকম হতে পারে, তাই শুধু এই তথ্য দিয়ে কারণ নিশ্চিত করা যায় না। ব্যথা তীব্র/বাড়তে থাকা, পেট শক্ত হয়ে যাওয়া, রক্তবমি/রক্তপায়খানা, অজ্ঞানভাব, গর্ভাবস্থায় ব্যথা বা জ্বরসহ ব্যথা হলে দ্রুত চিকিৎসা নিন। ব্যথা কোথায়, কতক্ষণ ধরে এবং অন্য কী লক্ষণ আছে তা জানান।",
      "Abdominal pain can have many causes and cannot be diagnosed from this information alone. Seek urgent care for severe or worsening pain, a rigid abdomen, blood in vomit or stool, fainting, pain during pregnancy, or pain with fever. Tell me where the pain is, how long it has lasted, and what other symptoms you have."
    );
  }

  // Medication questions
  if (
    /(medicine|medication|tablet|dose|dosage|antibiotic|ওষুধ|ট্যাবলেট|ডোজ|অ্যান্টিবায়োটিক|অ্যান্টিবায়োটিক)/i.test(
      text
    )
  ) {
    return reply(
      "ওষুধের সঠিক ব্যবহার বয়স, রোগ, অন্যান্য ওষুধ, অ্যালার্জি এবং গর্ভাবস্থার মতো বিষয়ের ওপর নির্ভর করে। আমি আপনার জন্য রোগ নির্ণয় বা ব্যক্তিগত ডোজ নির্ধারণ করতে পারি না। ওষুধের নাম ও প্যাকেটে লেখা শক্তি/মাত্রা জানালে সাধারণ ব্যবহার ও সতর্কতা ব্যাখ্যা করতে পারি। চিকিৎসকের নির্দেশ ছাড়া অ্যান্টিবায়োটিক শুরু বা প্রেসক্রিপশনের ওষুধ বন্ধ করবেন না।",
      "Safe medication use depends on age, condition, other medicines, allergies, and factors such as pregnancy. I cannot diagnose you or set a personal dose. If you share the medicine name and strength printed on the package, I can explain general uses and precautions. Do not start antibiotics or stop prescribed medication without professional advice."
    );
  }

  // Pregnancy
  if (
    /(pregnan|গর্ভবতী|গর্ভাবস্থা|প্রেগন্যান্ট)/i.test(
      text
    )
  ) {
    return reply(
      "গর্ভাবস্থায় ওষুধ বা চিকিৎসা বেছে নেওয়ার আগে চিকিৎসক/প্রসূতি বিশেষজ্ঞের পরামর্শ নিন। প্রচুর রক্তপাত, তীব্র পেটব্যথা, অজ্ঞানভাব, তীব্র মাথাব্যথা বা শ্বাসকষ্ট হলে জরুরি চিকিৎসা নিন। আপনি কত সপ্তাহের গর্ভবতী এবং কী লক্ষণ হচ্ছে তা জানালে সাধারণ তথ্য দিতে পারি।",
      "During pregnancy, consult a clinician or obstetric professional before taking medicines or choosing treatment. Seek urgent care for heavy bleeding, severe abdominal pain, fainting, severe headache, or breathing difficulty. If you share how many weeks pregnant you are and your symptoms, I can offer general information."
    );
  }

  // Fallback
  return reply(
    "আমি আপনার কথাটি পুরোপুরি বুঝতে পারিনি। অনুগ্রহ করে আপনার লক্ষণ, বয়স, কতক্ষণ/কতদিন ধরে হচ্ছে এবং অন্য কোনো সমস্যা আছে কি না একটু বিস্তারিত লিখুন। আমি সাধারণ স্বাস্থ্যতথ্য দিতে পারি, তবে রোগ নির্ণয় বা প্রেসক্রিপশন দিতে পারি না। গুরুতর বা দ্রুত বাড়তে থাকা লক্ষণ হলে সরাসরি চিকিৎসা নিন।",
    "I could not fully understand your question. Please describe your symptoms, age, how long they have been happening, and any other concerns. I can provide general health information, but I cannot diagnose or prescribe treatment. Seek medical care directly for severe or rapidly worsening symptoms."
  );
}

// =====================================================
// CHAT API — NO GEMINI KEY REQUIRED
// =====================================================

app.post("/chat", (req, res) => {
  try {
    const message = clean(req.body?.message);

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Message is required",
      });
    }

    const reply = getLocalMedicalReply(message);

    return res.json({
      success: true,
      reply,
    });
  } catch (error) {
    console.error(
      "LOCAL CHAT ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      error: "Chat response failed",
    });
  }
});

// =====================================================
// PRESCRIPTION AI — GEMINI
// =====================================================

app.post("/prescription", async (req, res) => {
  try {
    const text = clean(req.body?.text);

    if (!text) {
      return res.status(400).json({
        success: false,
        error: "Prescription text is required",
      });
    }

    if (!gemini) {
      return res.status(500).json({
        success: false,
        error: "Gemini API key is not configured",
      });
    }

    console.log("Prescription OCR text:");
    console.log(text);

    const result = await generateGeminiContent({
      contents: text,
      systemInstruction: `
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
- Do not recommend changing the prescribed dose.
- Tell the user to confirm the medicine name, dosage and price with a qualified doctor or pharmacist.

LANGUAGE:
- Respond in the same language used in the prescription/request when possible.
- If the user asks in Bangla, respond in Bangla.
- If the user asks in English, respond in English.
- Banglish is also acceptable when the user communicates in Banglish.

Use this format:

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
      maxOutputTokens: 1500,
    });

    console.log("Prescription AI result received");

    return res.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error(
      "PRESCRIPTION ERROR:",
      error?.message || error
    );

    const retryable = isRetryableGeminiError(error);

    return res.status(retryable ? 503 : 500).json({
      success: false,
      error: retryable
        ? "AI service is temporarily busy. Please try again in a moment."
        : "Prescription analysis failed",
      details: error?.message || "Unknown error",
    });
  }
});

// =====================================================
// LOCATIONS
// =====================================================

// GET ALL DIVISIONS
app.get("/locations/divisions", async (req, res) => {
  try {
    const cacheKey = "bd-divisions";
    const cached = getCache(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    const response = await fetch(`${BD_API}/divisions`);

    if (!response.ok) {
      throw new Error(
        `BD API returned ${response.status}`
      );
    }

    const result = await response.json();

    const divisions = (result.data || []).map((item) => ({
      name: clean(item.division),
      nameBn: clean(item.divisionbn),
      coordinates: parseCoordinates(item.coordinates),
    }));

    const data = {
      success: true,
      data: divisions,
    };

    setCache(cacheKey, data, 1440);

    return res.json(data);
  } catch (error) {
    console.error("DIVISION ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to load divisions",
      details: error?.message || "Unknown error",
    });
  }
});

// GET DISTRICTS OF DIVISION
app.get(
  "/locations/districts/:division",
  async (req, res) => {
    try {
      const division = clean(req.params.division);

      if (!division) {
        return res.status(400).json({
          success: false,
          error: "Division is required",
        });
      }

      const cacheKey =
        `bd-division-${division.toLowerCase()}`;

      const cached = getCache(cacheKey);

      if (cached) {
        return res.json(cached);
      }

      const response = await fetch(
        `${BD_API}/division/${encodeURIComponent(division)}`
      );

      if (!response.ok) {
        throw new Error(
          `BD API returned ${response.status}`
        );
      }

      const result = await response.json();

      const districts = (result.data || []).map((item) => ({
        name: clean(item.district),
        nameBn: clean(item.districtbn),
        coordinates: parseCoordinates(item.coordinates),
        upazilas: Array.isArray(item.upazilla)
          ? item.upazilla
          : [],
      }));

      const data = {
        success: true,
        division,
        data: districts,
      };

      setCache(cacheKey, data, 1440);

      return res.json(data);
    } catch (error) {
      console.error("DISTRICT ERROR:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to load districts",
        details: error?.message || "Unknown error",
      });
    }
  }
);

// GET UPAZILAS OF DISTRICT
app.get(
  "/locations/upazilas/:district",
  async (req, res) => {
    try {
      const district = clean(req.params.district);

      if (!district) {
        return res.status(400).json({
          success: false,
          error: "District is required",
        });
      }

      const cacheKey =
        `bd-district-${district.toLowerCase()}`;

      const cached = getCache(cacheKey);

      if (cached) {
        return res.json(cached);
      }

      const response = await fetch(
        `${BD_API}/district/${encodeURIComponent(district)}`
      );

      if (!response.ok) {
        throw new Error(
          `BD API returned ${response.status}`
        );
      }

      const result = await response.json();
      const first = result.data?.[0];
      const upazilas = first?.upazilla || [];

      const data = {
        success: true,
        district,
        data: upazilas.map((name) => ({
          name: clean(name),
        })),
      };

      setCache(cacheKey, data, 1440);

      return res.json(data);
    } catch (error) {
      console.error("UPAZILA ERROR:", error);

      return res.status(500).json({
        success: false,
        error: "Unable to load upazilas",
        details: error?.message || "Unknown error",
      });
    }
  }
);

// =====================================================
// NOMINATIM GEOCODING
// =====================================================

async function geocodeLocation({
  division,
  district,
  upazila,
}) {
  const parts = [
    upazila,
    district,
    division,
    "Bangladesh",
  ].filter(Boolean);

  const query = parts.join(", ");

  const url =
    `${NOMINATIM_URL}` +
    `?format=jsonv2` +
    `&limit=1` +
    `&q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": APP_USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Nominatim returned ${response.status}`
    );
  }

  const results = await response.json();

  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }

  const result = results[0];
  const lat = Number(result.lat);
  const lon = Number(result.lon);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return null;
  }

  return {
    lat,
    lon,
    displayName: result.display_name || "",
  };
}

// =====================================================
// OPENSTREETMAP HOSPITAL SEARCH
// =====================================================

async function searchHospitals({
  lat,
  lon,
  radius,
  keyword = "",
}) {
  const safeKeyword = clean(keyword)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .slice(0, 80);

  const keywordFilter = safeKeyword
    ? `["name"~"${safeKeyword}",i]`
    : "";

  const query = `
[out:json][timeout:30];
(
  node["amenity"="hospital"]${keywordFilter}(around:${radius},${lat},${lon});
  way["amenity"="hospital"]${keywordFilter}(around:${radius},${lat},${lon});
  relation["amenity"="hospital"]${keywordFilter}(around:${radius},${lat},${lon});

  node["healthcare"="hospital"]${keywordFilter}(around:${radius},${lat},${lon});
  way["healthcare"="hospital"]${keywordFilter}(around:${radius},${lat},${lon});
  relation["healthcare"="hospital"]${keywordFilter}(around:${radius},${lat},${lon});

  node["amenity"="clinic"]${keywordFilter}(around:${radius},${lat},${lon});
  way["amenity"="clinic"]${keywordFilter}(around:${radius},${lat},${lon});
  relation["amenity"="clinic"]${keywordFilter}(around:${radius},${lat},${lon});
);
out center tags;
`;

  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
      "User-Agent": APP_USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!response.ok) {
    throw new Error(
      `Overpass returned ${response.status}`
    );
  }

  return response.json();
}

// =====================================================
// NORMALIZE HOSPITAL
// =====================================================

function normalizeHospital(element) {
  const tags = element.tags || {};

  let latitude =
    element.lat ??
    element.center?.lat ??
    null;

  let longitude =
    element.lon ??
    element.center?.lon ??
    null;

  latitude = Number.isFinite(Number(latitude))
    ? Number(latitude)
    : null;

  longitude = Number.isFinite(Number(longitude))
    ? Number(longitude)
    : null;

  const operatorType =
    clean(tags["operator:type"]).toLowerCase();

  let type = "Healthcare facility";

  if (operatorType === "government") {
    type = "Government";
  } else if (operatorType === "private") {
    type = "Private";
  } else if (operatorType === "religious") {
    type = "Religious";
  } else if (operatorType === "community") {
    type = "Community";
  }

  const phone =
    clean(tags.phone) ||
    clean(tags["contact:phone"]) ||
    clean(tags.mobile);

  const website =
    clean(tags.website) ||
    clean(tags["contact:website"]);

  const email =
    clean(tags.email) ||
    clean(tags["contact:email"]);

  const address = [
    clean(tags["addr:housenumber"]),
    clean(tags["addr:street"]),
    clean(tags["addr:suburb"]),
    clean(tags["addr:neighbourhood"]),
    clean(tags["addr:city"]),
    clean(tags["addr:district"]),
  ]
    .filter(Boolean)
    .join(", ");

  const name =
    clean(tags.name) ||
    clean(tags["official_name"]) ||
    "Unnamed Healthcare Facility";

  return {
    id: `${element.type}-${element.id}`,
    name,
    officialName: clean(tags["official_name"]),
    type,
    operator: clean(tags.operator),
    address,
    phone,
    email,
    website,
    emergency: clean(tags.emergency),
    beds: clean(tags.beds),
    openingHours: clean(tags.opening_hours),
    healthcare: clean(tags.healthcare),
    latitude,
    longitude,
    rating: null,
    reviewCount: 0,
    source: "OpenStreetMap",
    sourceUrl:
      `https://www.openstreetmap.org/${element.type}/${element.id}`,
    mapsUrl:
      latitude !== null && longitude !== null
        ? `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`
        : null,
    directionsUrl:
      latitude !== null && longitude !== null
        ? `https://www.openstreetmap.org/directions?to=${latitude}%2C${longitude}`
        : null,
  };
}

// =====================================================
// HOSPITAL API
// =====================================================

app.get("/hospitals", async (req, res) => {
  try {
    const division = clean(req.query.division);
    const district = clean(req.query.district);
    const upazila = clean(req.query.upazila);
    const keyword = clean(req.query.keyword);

    if (!division) {
      return res.status(400).json({
        success: false,
        error: "Division is required",
      });
    }

    const cacheKey = [
      "hospitals",
      division,
      district,
      upazila,
      keyword,
    ]
      .join("|")
      .toLowerCase();

    const cached = getCache(cacheKey);

    if (cached) {
      return res.json(cached);
    }

    let radius = 50000;

    if (district) {
      radius = 25000;
    }

    if (upazila) {
      radius = 10000;
    }

    const location = await geocodeLocation({
      division,
      district,
      upazila,
    });

    if (!location) {
      return res.json({
        success: true,
        count: 0,
        data: [],
        message:
          "Location could not be found on the map.",
      });
    }

    const result = await searchHospitals({
      lat: location.lat,
      lon: location.lon,
      radius,
      keyword,
    });

    let hospitals = Array.isArray(result.elements)
      ? result.elements
          .map(normalizeHospital)
          .filter(
            (hospital) =>
              hospital.name !==
              "Unnamed Healthcare Facility"
          )
      : [];

    // Extra keyword filter
    if (keyword) {
      const search = keyword.toLowerCase();

      hospitals = hospitals.filter((hospital) => {
        const text = [
          hospital.name,
          hospital.officialName,
          hospital.operator,
          hospital.address,
        ]
          .join(" ")
          .toLowerCase();

        return text.includes(search);
      });
    }

    // Remove duplicates
    const unique = Array.from(
      new Map(
        hospitals.map((hospital) => {
          const key = [
            hospital.name,
            hospital.latitude,
            hospital.longitude,
          ]
            .join("|")
            .toLowerCase();

          return [key, hospital];
        })
      ).values()
    );

    // Sort by name
    unique.sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    const data = {
      success: true,
      source: ["OpenStreetMap"],
      location: {
        division,
        district,
        upazila,
        latitude: location.lat,
        longitude: location.lon,
      },
      search: {
        keyword,
      },
      count: unique.length,
      data: unique,
      attribution:
        "Hospital data © OpenStreetMap contributors",
    };

    setCache(cacheKey, data, 15);

    return res.json(data);
  } catch (error) {
    console.error(
      "HOSPITAL SEARCH ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      error: "Unable to find hospitals",
      details: error?.message || "Unknown error",
    });
  }
});

// =====================================================
// DOCTOR DATABASE
// =====================================================

function loadDoctors() {
  try {
    if (!fs.existsSync(DOCTORS_FILE)) {
      console.warn(
        `Doctor database not found: ${DOCTORS_FILE}`
      );

      return [];
    }

    const fileContent = fs.readFileSync(
      DOCTORS_FILE,
      "utf8"
    );

    const doctors = JSON.parse(fileContent);

    if (!Array.isArray(doctors)) {
      return [];
    }

    return doctors;
  } catch (error) {
    console.error(
      "DOCTOR DATABASE ERROR:",
      error
    );

    return [];
  }
}

// =====================================================
// GET ALL / FILTERED DOCTORS
// =====================================================

app.get("/doctors", async (req, res) => {
  try {
    const specialty = clean(req.query.specialty);
    const division = clean(req.query.division);
    const district = clean(req.query.district);
    const upazila = clean(req.query.upazila);

    let doctors = loadDoctors();

    if (specialty) {
      const value = specialty.toLowerCase();

      doctors = doctors.filter(
        (doctor) =>
          clean(doctor.specialty).toLowerCase() === value ||
          clean(doctor.specialtyBn).toLowerCase() === value
      );
    }

    if (division) {
      const value = division.toLowerCase();

      doctors = doctors.filter(
        (doctor) =>
          clean(doctor.division).toLowerCase() === value ||
          clean(doctor.divisionBn).toLowerCase() === value
      );
    }

    if (district) {
      const value = district.toLowerCase();

      doctors = doctors.filter(
        (doctor) =>
          clean(doctor.district).toLowerCase() === value ||
          clean(doctor.districtBn).toLowerCase() === value
      );
    }

    if (upazila) {
      const value = upazila.toLowerCase();

      doctors = doctors.filter(
        (doctor) =>
          clean(doctor.upazila).toLowerCase() === value ||
          clean(doctor.upazilaBn).toLowerCase() === value
      );
    }

    return res.json({
      success: true,
      filters: {
        specialty,
        division,
        district,
        upazila,
      },
      count: doctors.length,
      data: doctors,
    });
  } catch (error) {
    console.error(
      "DOCTOR SEARCH ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      error: "Unable to load doctors",
      details: error?.message || "Unknown error",
    });
  }
});

// =====================================================
// DOCTOR SPECIALTIES
// IMPORTANT: This route must be BEFORE /doctors/:id
// =====================================================

app.get("/doctors/specialties", async (req, res) => {
  try {
    const doctors = loadDoctors();
    const specialties = [];

    for (const doctor of doctors) {
      const name = clean(doctor.specialty);
      const nameBn = clean(doctor.specialtyBn);

      if (!name) {
        continue;
      }

      const exists = specialties.some(
        (item) => item.name === name
      );

      if (!exists) {
        specialties.push({
          name,
          nameBn,
        });
      }
    }

    specialties.sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return res.json({
      success: true,
      count: specialties.length,
      data: specialties,
    });
  } catch (error) {
    console.error("SPECIALTY ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to load specialties",
      details: error?.message || "Unknown error",
    });
  }
});

// =====================================================
// GET SINGLE DOCTOR
// =====================================================

app.get("/doctors/:id", async (req, res) => {
  try {
    const id = clean(req.params.id);
    const doctors = loadDoctors();

    const doctor = doctors.find(
      (item) => clean(item.id) === id
    );

    if (!doctor) {
      return res.status(404).json({
        success: false,
        error: "Doctor not found",
      });
    }

    return res.json({
      success: true,
      data: doctor,
    });
  } catch (error) {
    console.error(
      "DOCTOR DETAILS ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      error: "Unable to load doctor",
      details: error?.message || "Unknown error",
    });
  }
});

// =====================================================
// 404 HANDLER
// =====================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "API endpoint not found",
    path: req.originalUrl,
  });
});

// =====================================================
// GLOBAL ERROR HANDLER
// =====================================================

app.use((error, req, res, next) => {
  console.error(
    "GLOBAL SERVER ERROR:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    success: false,
    error: "Internal server error",
    details: error?.message || "Unknown error",
  });
});

// =====================================================
// PROCESS ERROR LOGGING
// =====================================================

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:");
  console.error(error);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED PROMISE REJECTION:");
  console.error(reason);
});

// =====================================================
// START SERVER
// =====================================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log("========================================");
    console.log("       MEDI BACKEND SERVER");
    console.log("========================================");
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Doctor database: ${DOCTORS_FILE}`);
    console.log(`Gemini model: ${GEMINI_MODEL}`);
    console.log(
      GEMINI_API_KEY
        ? "Gemini API: Configured"
        : "Gemini API: NOT configured"
    );
    console.log("Hospital data: OpenStreetMap");
    console.log(
      DGHS_X_AUTH_TOKEN && DGHS_CLIENT_ID
        ? "DGHS API: Configured"
        : "DGHS API: Not configured"
    );
    console.log("========================================");
    console.log("");
  }
);

server.on("error", (error) => {
  console.error("SERVER START ERROR:");

  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use.`
    );
  } else {
    console.error(error);
  }
});