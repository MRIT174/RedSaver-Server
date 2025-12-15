require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

let admin;
try {
  admin = require("firebase-admin");
} catch {
  admin = null;
}

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

/* -------------------- Firebase Admin -------------------- */
let firebaseInitialized = false;

if (admin && process.env.FB_SERVICE_KEY) {
  try {
    const decoded = Buffer.from(
      process.env.FB_SERVICE_KEY,
      "base64"
    ).toString("utf8");

    const serviceAccount = JSON.parse(decoded);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    firebaseInitialized = true;
    console.log("✅ Firebase Admin initialized");
  } catch (err) {
    console.warn("❌ Firebase init failed:", err);
  }
}

const uri = `mongodb+srv://${encodeURIComponent(
  process.env.DB_USER
)}:${encodeURIComponent(process.env.DB_PASS)}@cluster0.ysjwzre.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1 },
});

let db;
async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("RedSaver");
    console.log("✅ MongoDB connected");
  }
  return db;
}

const verifyFBToken = async (req, res, next) => {
  if (!firebaseInitialized)
    return res.status(500).json({ message: "Firebase not configured" });

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer "))
    return res.status(401).json({ message: "Unauthorized" });

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};

async function run() {
  await connectDB();

  const usersColl = db.collection("users");
  const donationsColl = db.collection("donations");
  const fundsColl = db.collection("funds");
  const divisionsColl = db.collection("divisions");
  const districtsColl = db.collection("districts");

  const verifyAdmin = async (req, res, next) => {
    const user = await usersColl.findOne({ email: req.decoded_email });
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Admin only" });
    }
    next();
  };


  app.get("/", (req, res) => {
    res.status(200).json({
      success: true,
      message: "RedSaver API running",
    });
  });

  app.post("/users", async (req, res) => {
    const user = req.body;
    if (!user?.email)
      return res.status(400).json({ message: "Email required" });

    const existing = await usersColl.findOne({ email: user.email });

    const data = {
      email: user.email,
      name: user.name || existing?.name || "",
      role: existing?.role || "donor",
      status: existing?.status || "active",
      updatedAt: new Date(),
    };

    if (!existing) data.createdAt = new Date();

    await usersColl.updateOne(
      { email: user.email },
      { $set: data },
      { upsert: true }
    );

    res.json({ success: true });
  });

  app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
    res.json(await usersColl.find().toArray());
  });

  app.get("/users/:email", async (req, res) => {
    res.json(await usersColl.findOne({ email: req.params.email }) || {});
  });

  app.post("/donations", verifyFBToken, async (req, res) => {
    const result = await donationsColl.insertOne({
      ...req.body,
      status: "pending",
      createdAt: new Date(),
    });
    res.json({ success: true, id: result.insertedId });
  });

  app.get("/donations", verifyFBToken, async (req, res) => {
    const { status } = req.query;
    const query = status ? { status } : {};
    res.json(
      await donationsColl.find(query).sort({ createdAt: -1 }).toArray()
    );
  });

  app.patch("/donations/:id", verifyFBToken, async (req, res) => {
    const result = await donationsColl.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: req.body.status } }
    );
    res.json({ success: true, result });
  });

  app.post("/funds", verifyFBToken, async (req, res) => {
    const fund = { ...req.body, date: new Date() };
    const result = await fundsColl.insertOne(fund);
    res.json({ success: true, id: result.insertedId });
  });

  app.get("/funds", verifyFBToken, async (req, res) => {
    res.json(await fundsColl.find().toArray());
  });

  app.get("/api/divisions", async (req, res) => {
    res.json(await divisionsColl.find().toArray());
  });

  app.get("/api/districts", async (req, res) => {
    const query = req.query.division
      ? { division_id: req.query.division }
      : {};
    res.json(await districtsColl.find(query).toArray());
  });

  app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: req.body.amount * 100,
      currency: "bdt",
      payment_method_types: ["card"],
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  });

  console.log(" All routes registered");
}

run().catch(console.error);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
