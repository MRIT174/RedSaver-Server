require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
let admin;

try {
  admin = require("firebase-admin");
} catch (e) {
  admin = null;
}

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

let firebaseInitialized = false;
if (admin) {
  try {
    const serviceAccount = require("./redsaver-394f421cdb.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseInitialized = true;
    console.log("Firebase Admin initialized");
  } catch (err) {
    console.warn("Firebase Admin init failed", err);
  }
}

const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;

if (!DB_USER || !DB_PASS) {
  console.error("DB_USER or DB_PASS missing");
  process.exit(1);
}

const uri = `mongodb+srv://${encodeURIComponent(DB_USER)}:${encodeURIComponent(
  DB_PASS
)}@cluster0.ysjwzre.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1 } });
let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("RedSaver");
    console.log("MongoDB connected");
  }
  return db;
}

async function verifyFBToken(req, res, next) {
  if (!firebaseInitialized)
    return res.status(500).json({ message: "Firebase not configured" });

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer "))
    return res.status(401).json({ message: "Unauthorized" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    req.decoded_uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
}

async function run() {
  await connectDB();

  const usersColl = db.collection("users");
  const donationsColl = db.collection("donations");
  const fundsColl = db.collection("funds");
  const divisionsColl = db.collection("divisions");
  const districtsColl = db.collection("districts");

  const verifyAdmin = async (req, res, next) => {
    const email = req.decoded_email;
    const user = await usersColl.findOne({ email });
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Admin only access" });
    }
    next();
  };

  app.get("/", (req, res) => {
    res.json({ success: true, message: "RedSaver API Running" });
  });

  app.post("/users", async (req, res) => {
    const user = req.body;
    if (!user?.email) return res.status(400).json({ message: "Email required" });

    const existingUser = await usersColl.findOne({ email: user.email });
    const data = {
      email: user.email,
      name: user.name || existingUser?.name || "",
      avatar: user.avatar || existingUser?.avatar || "",
      bloodGroup: user.bloodGroup || existingUser?.bloodGroup || "",
      division: user.division || existingUser?.division || "",
      district: user.district || existingUser?.district || "",
      upazila: user.upazila || existingUser?.upazila || "",
      status: existingUser?.status || "active",
      updatedAt: new Date(),
    };

    if (!existingUser) {
      data.role = "donor";
      data.createdAt = new Date();
    }

    await usersColl.updateOne({ email: user.email }, { $set: data }, { upsert: true });
    res.json({ success: true });
  });

  app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
    const users = await usersColl.find().toArray();
    res.json(users);
  });

  app.get("/users/:email", async (req, res) => {
    const user = await usersColl.findOne({ email: req.params.email });
    res.json(user || {});
  });

  app.put("/users/:email", verifyFBToken, async (req, res) => {
    const email = req.params.email;
    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData.role;
    const result = await usersColl.updateOne({ email }, { $set: updateData });
    res.json({ success: true, result });
  });

  app.patch("/users/block/:email", verifyFBToken, verifyAdmin, async (req, res) => {
    const result = await usersColl.updateOne({ email: req.params.email }, { $set: { status: "blocked" } });
    res.json({ success: true, message: "User blocked", result });
  });

  app.patch("/users/unblock/:email", verifyFBToken, verifyAdmin, async (req, res) => {
    const result = await usersColl.updateOne({ email: req.params.email }, { $set: { status: "active" } });
    res.json({ success: true, message: "User unblocked", result });
  });

  app.patch("/users/role/:email", verifyFBToken, verifyAdmin, async (req, res) => {
    const { role } = req.body;
    const result = await usersColl.updateOne({ email: req.params.email }, { $set: { role } });
    res.json({ success: true, message: `User role updated to ${role}`, result });
  });

  app.get("/api/donors", async (req, res) => {
    try {
      const { bloodGroup, division, district } = req.query;
      const query = { role: "donor", status: "active" };

      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (division) query.division = String(division);
      if (district) query.district = String(district);

      const donors = await usersColl.find(query).toArray();
      res.json(donors);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch donors" });
    }
  });

  app.get("/api/divisions", async (req, res) => {
    try {
      const divisions = await divisionsColl.find({}).toArray();
      res.json(divisions);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch divisions" });
    }
  });

  app.get("/api/districts", async (req, res) => {
    try {
      const { division } = req.query;
      let query = {};
      if (division) query.division_id = String(division);
      const districts = await districtsColl.find(query).toArray();
      res.json(districts);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch districts" });
    }
  });

  app.post("/donations", verifyFBToken, async (req, res) => {
    const data = { ...req.body, createdAt: new Date() };
    const result = await donationsColl.insertOne(data);
    res.json({ success: true, result });
  });

  app.get("/donations", verifyFBToken, async (req, res) => {
    try {
      const donations = await donationsColl.find({}).sort({ createdAt: -1 }).toArray();
      res.json(donations);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to fetch donations" });
    }
  });

  app.patch("/donations/:id", verifyFBToken, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "Status required" });

    const result = await donationsColl.updateOne({ _id: new ObjectId(id) }, { $set: { status } });
    if (result.matchedCount === 0) return res.status(404).json({ message: "Donation not found" });
    res.json({ success: true, message: `Donation status updated to ${status}` });
  });

  app.delete("/donations/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    const result = await donationsColl.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Donation not found" });
    res.json({ success: true, message: "Donation deleted" });
  });

  app.get("/funds", verifyFBToken, async (req, res) => {
    const funds = await fundsColl.find({}).sort({ date: -1 }).toArray();
    res.json(funds);
  });

  app.get("/funds/total", verifyFBToken, verifyAdmin, async (req, res) => {
    const result = await fundsColl.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]).toArray();
    res.json({ total: result[0]?.total || 0 });
  });

  app.post("/funds", verifyFBToken, async (req, res) => {
    const { amount, donorName, donorEmail } = req.body;
    if (!amount || !donorName || !donorEmail) return res.status(400).json({ message: "Missing required fields" });

    const fund = { amount, donorName, donorEmail, date: new Date() };
    const result = await fundsColl.insertOne(fund);
    res.json({ success: true, fundId: result.insertedId });
  });

app.get("/api/divisions", async (req, res) => {
  const divisions = await divisionsColl.find({}).toArray();
  res.json(divisions);
});

app.get("/api/districts", async (req, res) => {
  const { division } = req.query;
  const query = division ? { division_id: String(division) } : {};
  const districts = await districtsColl.find(query).toArray();
  res.json(districts);
});


app.get("/api/divisions", async (req, res) => {
  try {
    const divisions = await divisionsColl.find({}).toArray();
    res.json(divisions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch divisions" });
  }
});

app.get("/api/districts", async (req, res) => {
  try {
    const { division } = req.query;
    let query = {};
    if (division) query.division_id = String(division);
    const districts = await districtsColl.find(query).toArray();
    res.json(districts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch districts" });
  }
});

  app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ message: "Amount required" });

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount * 100,
        currency: "bdt",
        payment_method_types: ["card"],
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Stripe payment failed" });
    }
  });

  console.log("All routes registered");
}

run().catch(console.error);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
