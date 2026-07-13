import { useState, useEffect, useRef } from "react";
import {
  MessageCircle, CreditCard, MapPin, ArrowLeft, ShoppingBasket, Search,
  Lock, Plus, Pencil, Trash2, LogOut, Save, X, Loader2, UserPlus, Check, Clock, Shield, Share2,
} from "lucide-react";
import { db, auth } from "./firebase.js";
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc, getDoc, setDoc,
  onSnapshot, query, where, serverTimestamp,
} from "firebase/firestore";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut,
} from "firebase/auth";

const SUPER_ADMIN_EMAIL = "thrivesocietyofficial@gmail.com";
const SOCIETY_UPI_ID = "ayuvrajsingh901@ybl";
const MONTHLY_FEE = 100;
// ⚠️ Yahan society/admin ka asli WhatsApp number daalo (91 ke saath, bina + ya space)
const SOCIETY_WHATSAPP = "918959992195";

// ─── Payment Config ───────────────────────────────────────────────────────────
// Sirf yahan "false" ko "true" karo jab paid plans start karni ho
// Kuch aur nahi badalna padega
const PAYMENT_ENABLED = false;

async function uploadToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", "mitti-ki-dukan");
  const res = await fetch("https://api.cloudinary.com/v1_1/dbkaysc6w/image/upload", {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!data.secure_url) throw new Error("Upload failed");
  return data.secure_url;
}

async function payWithRazorpay({ amount, name, description, onSuccess, onFail }) {
  try {
    const res = await fetch("/api/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, receipt: "mitti_" + Date.now() }),
    });
    const data = await res.json();
    if (!data.orderId) throw new Error(data.error || "Order create failed");

    const options = {
      key: data.keyId,
      amount: data.amount,
      currency: data.currency,
      name: "हमारी मिट्टी की दुकान",
      description: description,
      order_id: data.orderId,
      handler: function (response) { onSuccess(response); },
      prefill: { name: name || "" },
      theme: { color: "#A8472E" },
      modal: { ondismiss: function () { if (onFail) onFail("cancelled"); } },
    };

    if (!window.Razorpay) {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      document.body.appendChild(script);
      await new Promise((resolve) => { script.onload = resolve; });
    }

    const rzp = new window.Razorpay(options);
    rzp.open();
  } catch (err) {
    if (onFail) onFail(err.message);
  }
}

const CATEGORIES = ["अचार", "पापड़", "मशरूम", "अन्य"];

const C = {
  bg: "#FBF5EC",
  card: "#FFFFFF",
  border: "#E8DCC3",
  accent: "#A8472E",
  accentSoft: "#F2E2D5",
  textHeading: "#2E2418",
  textBody: "#5C4C3A",
  textMuted: "#8A7A64",
};

// ─── Responsive wrapper ───────────────────────────────────────────────────────
function Page({ children, wide = false }) {
  return (
    <div className="min-h-screen w-full" style={{ background: C.bg }}>
      <div className={wide ? "max-w-6xl mx-auto" : "max-w-lg mx-auto"}>
        {children}
      </div>
    </div>
  );
}

// ─── Data hooks ───────────────────────────────────────────────────────────────
function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "products"));
      setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setError("");
    } catch (e) {
      setError("Firebase से जुड़ नहीं पाया — कृपया src/firebase.js में अपनी config check करें।");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const addProduct = async (data, ownerId) => {
    await addDoc(collection(db, "products"), { ...data, price: Number(data.price), ownerId });
    await load();
  };
  const updateProduct = async (id, data) => {
    await updateDoc(doc(db, "products", id), { ...data, price: Number(data.price) });
    await load();
  };
  const removeProduct = async (id) => {
    await deleteDoc(doc(db, "products", id));
    await load();
  };

  return { products, loading, error, addProduct, updateProduct, removeProduct, reload: load };
}

function useVendor(user) {
  const [vendor, setVendor] = useState(null);
  const [vendorLoading, setVendorLoading] = useState(true);

  const load = async () => {
    if (!user) { setVendor(null); setVendorLoading(false); return; }
    setVendorLoading(true);
    try {
      const snap = await getDoc(doc(db, "vendors", user.uid));
      setVendor(snap.exists() ? snap.data() : null);
    } catch { setVendor(null); }
    finally { setVendorLoading(false); }
  };

  useEffect(() => { load(); }, [user?.uid]);
  return { vendor, vendorLoading, reloadVendor: load };
}

function useAllVendors() {
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "vendors"));
      setVendors(snap.docs.map((d) => ({ uid: d.id, ...d.data() })));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  return { vendors, loading, reload: load };
}

function useAuthUser() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  return { user, authLoading };
}

// ─── Order system ──────────────────────────────────────────────────────────────
// Order status flow:
//  COD:  pending -> accepted -> packed -> out_for_delivery -> delivered  (या rejected/cancelled kabhi bhi)
//  UPI:  payment_pending -> pending (seller verify karne ke baad) -> ...same as COD
const ORDER_STATUS_META = {
  payment_pending: { label: "Payment Verification Pending", bg: "#FCEFC7", fg: "#8A6A00" },
  pending: { label: "Pending", bg: "#FCEFC7", fg: "#8A6A00" },
  accepted: { label: "Accepted", bg: "#E4E8FB", fg: "#33429E" },
  packed: { label: "Packed", bg: "#E4E8FB", fg: "#33429E" },
  out_for_delivery: { label: "Out for Delivery", bg: "#E4E8FB", fg: "#33429E" },
  delivered: { label: "Delivered", bg: "#DCF3DD", fg: "#226B2E" },
  rejected: { label: "Rejected", bg: "#FBE2DD", fg: "#B83A2A" },
  cancelled: { label: "Cancelled", bg: "#FBE2DD", fg: "#B83A2A" },
};

function OrderStatusBadge({ status }) {
  const meta = ORDER_STATUS_META[status] || { label: status, bg: "#EEE", fg: "#555" };
  return (
    <span className="text-[11px] font-semibold px-2 py-1 rounded-full" style={{ background: meta.bg, color: meta.fg }}>
      {meta.label}
    </span>
  );
}

const ORDER_TABS = [
  { key: "payment_pending", label: "Payment Pending" },
  { key: "pending", label: "Pending" },
  { key: "accepted", label: "Accepted" },
  { key: "packed", label: "Packed" },
  { key: "out_for_delivery", label: "Out for Delivery" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled_rejected", label: "Cancelled/Rejected" },
];

async function placeOrder(orderData) {
  const ref = await addDoc(collection(db, "orders"), {
    ...orderData,
    createdAt: serverTimestamp(),
  });
  // customer ke device par order ID yaad rakho — "मेरे Orders" page ke liye (koi login nahi chahिए)
  try {
    const list = JSON.parse(localStorage.getItem("mkd_my_orders") || "[]");
    list.unshift({ id: ref.id, productName: orderData.productName, date: new Date().toISOString() });
    localStorage.setItem("mkd_my_orders", JSON.stringify(list.slice(0, 50)));
  } catch {}
  return ref.id;
}

async function updateOrderStatus(orderId, fields) {
  await updateDoc(doc(db, "orders", orderId), fields);
}

function useSellerOrders(ownerId) {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    if (!ownerId) { setOrders([]); return; }
    const q = query(collection(db, "orders"), where("ownerId", "==", ownerId));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      setOrders(list);
    });
    return unsub;
  }, [ownerId]);
  return orders;
}

// Admin ke liye — poore platform ke saare orders (sabhi vendors ke)
function useAllOrders(enabled) {
  const [orders, setOrders] = useState([]);
  useEffect(() => {
    if (!enabled) { setOrders([]); return; }
    const unsub = onSnapshot(collection(db, "orders"), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      setOrders(list);
    });
    return unsub;
  }, [enabled]);
  return orders;
}

// Customer ke "मेरे Orders" — koi login nahi hai, isliye localStorage mein saved IDs se
// har order document ko live subscribe karte hain (real-time status update ke liye)
function useMyOrders() {
  const [ids, setIds] = useState(() => {
    try { return (JSON.parse(localStorage.getItem("mkd_my_orders") || "[]")).map((o) => o.id); }
    catch { return []; }
  });
  const [orders, setOrders] = useState({});

  useEffect(() => {
    const unsubs = ids.map((id) =>
      onSnapshot(doc(db, "orders", id), (snap) => {
        if (snap.exists()) setOrders((prev) => ({ ...prev, [id]: { id: snap.id, ...snap.data() } }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [ids.join(",")]);

  const list = ids.map((id) => orders[id]).filter(Boolean)
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  return list;
}

// ─── WhatsApp order form ──────────────────────────────────────────────────────
// Ab yeh sirf communication ke liye hai — order nahi lagta, seedha WhatsApp khulta hai
function ChatWithSellerLink({ product }) {
  const cleanPhone = (product.sellerPhone || "").replace(/\D/g, "");
  const phoneForLink = cleanPhone.length === 10 ? "91" + cleanPhone : cleanPhone;
  const link = "https://wa.me/" + phoneForLink + "?text=" +
    encodeURIComponent("नमस्ते! मुझे \"" + product.name + "\" के बारे में जानकारी चाहिए।");

  if (!cleanPhone) return null;

  return (
    <a href={link} target="_blank" rel="noopener noreferrer"
      className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-medium text-sm w-full"
      style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }}>
      <MessageCircle className="w-4 h-4" style={{ color: "#2BA84A" }} /> Chat with Seller on WhatsApp
    </a>
  );
}

// ─── Order Now — poora marketplace order + payment flow ───────────────────────
function OrderNow({ product }) {
  const [stage, setStage] = useState("closed"); // closed -> form -> upiPayment -> done
  const [cName, setCName] = useState("");
  const [cPhone, setCPhone] = useState("");
  const [cAddress, setCAddress] = useState("");
  const [cPincode, setCPincode] = useState("");
  const [qty, setQty] = useState(1);
  const [payMethod, setPayMethod] = useState("cod"); // "cod" | "upi"
  const [utr, setUtr] = useState("");
  const [placing, setPlacing] = useState(false);
  const [upiCopied, setUpiCopied] = useState(false);
  const [placedOrderId, setPlacedOrderId] = useState(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("mkd_customer_details") || "null");
      if (saved) {
        setCName(saved.name || "");
        setCPhone(saved.phone || "");
        setCAddress(saved.address || "");
        setCPincode(saved.pincode || "");
      }
    } catch {}
  }, []);

  const saveDetails = () => {
    try {
      localStorage.setItem("mkd_customer_details", JSON.stringify({ name: cName, phone: cPhone, address: cAddress, pincode: cPincode }));
    } catch {}
  };

  const detailsValid = cName.trim() && cPhone.trim().length >= 10 && cAddress.trim() && cPincode.trim().length === 6;
  const amount = (Number(product.price) || 0) * qty;
  const upiLink = product.upiId
    ? "upi://pay?pa=" + encodeURIComponent(product.upiId) + "&pn=" + encodeURIComponent(product.maker || "Vikreta") +
      "&am=" + amount + "&cu=INR" + "&tn=" + encodeURIComponent(product.name)
    : null;

  const copyUpiId = async () => {
    try {
      await navigator.clipboard.writeText(product.upiId);
      setUpiCopied(true);
      setTimeout(() => setUpiCopied(false), 2000);
    } catch { alert("UPI ID: " + product.upiId); }
  };

  const baseOrderData = () => ({
    productId: product.id,
    productName: product.name,
    productImg: product.img || (product.images && product.images[0]) || "",
    price: Number(product.price) || 0,
    quantity: qty,
    amount,
    unit: product.unit,
    ownerId: product.ownerId,
    sellerName: product.maker || "",
    sellerPhone: product.sellerPhone || "",
    customerName: cName.trim(),
    customerPhone: cPhone.trim(),
    customerAddress: cAddress.trim(),
    customerPincode: cPincode.trim(),
  });

  const placeCodOrder = async () => {
    if (!detailsValid) { alert("कृपया सभी details सही से भरें (पिनकोड 6 अंकों का होना चाहिए)।"); return; }
    setPlacing(true);
    try {
      saveDetails();
      const id = await placeOrder({
        ...baseOrderData(),
        paymentMethod: "cod",
        paymentStatus: "cod",
        status: "pending",
      });
      setPlacedOrderId(id);
      setStage("done");
    } catch (e) {
      alert("Order place नहीं हो पाया: " + e.message);
    } finally { setPlacing(false); }
  };

  const placeUpiOrder = async () => {
    if (!utr.trim()) { alert("कृपया Transaction ID (UTR) डालें, payment करने के बाद।"); return; }
    setPlacing(true);
    try {
      const id = await placeOrder({
        ...baseOrderData(),
        paymentMethod: "upi",
        paymentStatus: "pending_verification",
        utr: utr.trim(),
        status: "payment_pending",
      });
      setPlacedOrderId(id);
      setStage("done");
    } catch (e) {
      alert("Order place नहीं हो पाया: " + e.message);
    } finally { setPlacing(false); }
  };

  if (stage === "closed") {
    return (
      <button onClick={() => setStage("form")}
        className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm w-full"
        style={{ background: C.accent, color: "#FFFFFF" }}>
        <ShoppingBasket className="w-4 h-4" /> Order Now
      </button>
    );
  }

  if (stage === "done") {
    return (
      <div className="p-5 rounded-xl flex flex-col items-center text-center gap-2" style={{ background: "#DCF3DD", border: "1px solid #226B2E" }}>
        <Check className="w-8 h-8" style={{ color: "#226B2E" }} />
        <p className="font-semibold text-sm" style={{ color: "#226B2E" }}>
          {payMethod === "upi" ? "Order भेज दिया गया — Payment Verification Pending" : "Order सफलतापूर्वक Place हो गया!"}
        </p>
        <p className="text-xs" style={{ color: C.textBody }}>Order ID: {placedOrderId}</p>
        <p className="text-xs" style={{ color: C.textBody }}>Status "मेरे Orders" में देखा जा सकता है।</p>
      </div>
    );
  }

  // Step 1: form (details + quantity + payment method choice)
  if (stage === "form") {
    return (
      <div className="p-4 rounded-xl flex flex-col gap-2" style={{ background: C.card, border: "1px solid " + C.border }}>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold" style={{ color: C.textHeading }}>Order Details</p>
          <button onClick={() => setStage("closed")}><X className="w-4 h-4" style={{ color: C.textMuted }} /></button>
        </div>
        <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="आपका नाम"
          className="px-3 py-2 rounded-lg outline-none text-sm" style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
        <input value={cPhone} onChange={(e) => setCPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="मोबाइल नंबर" inputMode="numeric"
          className="px-3 py-2 rounded-lg outline-none text-sm" style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
        <textarea value={cAddress} onChange={(e) => setCAddress(e.target.value)} placeholder="पूरा Address (घर/गांव/लैंडमार्क)"
          rows={2} className="px-3 py-2 rounded-lg outline-none text-sm resize-none"
          style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
        <input value={cPincode} onChange={(e) => setCPincode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="पिनकोड" inputMode="numeric"
          className="px-3 py-2 rounded-lg outline-none text-sm" style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />

        <div className="flex items-center gap-3 mt-1">
          <p className="text-xs" style={{ color: C.textMuted }}>Quantity:</p>
          <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="w-7 h-7 rounded-full text-sm font-bold" style={{ background: C.accentSoft, color: C.accent }}>−</button>
          <span className="text-sm font-semibold" style={{ color: C.textHeading }}>{qty}</span>
          <button onClick={() => setQty((q) => q + 1)} className="w-7 h-7 rounded-full text-sm font-bold" style={{ background: C.accentSoft, color: C.accent }}>+</button>
          <p className="text-sm font-bold ml-auto" style={{ color: C.accent }}>&#x20B9;{amount}</p>
        </div>

        <p className="text-xs font-semibold mt-2" style={{ color: C.textHeading }}>Payment Method चुनें</p>
        <div className="flex gap-2">
          <button onClick={() => setPayMethod("cod")}
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium"
            style={payMethod === "cod" ? { background: C.accent, color: "#FFFFFF" } : { background: C.bg, border: "1px solid " + C.border, color: C.textBody }}>
            Cash on Delivery
          </button>
          <button onClick={() => setPayMethod("upi")} disabled={!product.upiId}
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40"
            style={payMethod === "upi" ? { background: C.accent, color: "#FFFFFF" } : { background: C.bg, border: "1px solid " + C.border, color: C.textBody }}>
            UPI Prepaid
          </button>
        </div>
        {!product.upiId && <p className="text-[11px]" style={{ color: C.textMuted }}>इस विक्रेता ने अभी UPI ID नहीं डाली — सिर्फ COD उपलब्ध है।</p>}

        <button onClick={() => payMethod === "cod" ? placeCodOrder() : (detailsValid ? setStage("upiPayment") : alert("कृपया सभी details सही से भरें।"))}
          disabled={placing}
          className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-medium text-sm mt-2 disabled:opacity-50"
          style={{ background: "#2BA84A", color: "#FFFFFF" }}>
          {placing ? <Loader2 className="w-4 h-4 animate-spin" /> : (payMethod === "cod" ? "Place Order" : "Payment करने आगे बढ़ें")}
        </button>
      </div>
    );
  }

  // Step 2 (UPI only): show UPI ID + copy + QR + UTR input
  if (stage === "upiPayment") {
    return (
      <div className="p-4 rounded-xl flex flex-col gap-3" style={{ background: C.card, border: "1px solid " + C.border }}>
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold" style={{ color: C.textHeading }}>UPI से Payment करें (&#x20B9;{amount})</p>
          <button onClick={() => setStage("form")}><X className="w-4 h-4" style={{ color: C.textMuted }} /></button>
        </div>

        <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: C.bg, border: "1px solid " + C.border }}>
          <p className="text-sm font-mono" style={{ color: C.textBody }}>{product.upiId}</p>
          <button onClick={copyUpiId} className="text-xs font-medium px-2 py-1 rounded" style={{ background: C.accentSoft, color: C.accent }}>
            {upiCopied ? "✓ Copy हुआ" : "Copy करें"}
          </button>
        </div>

        <div className="flex flex-col items-center gap-2 p-3 rounded-xl" style={{ background: C.bg, border: "1px solid " + C.border }}>
          <p className="text-xs" style={{ color: C.textMuted }}>किसी भी UPI app से यह QR code scan करें</p>
          <img src={"https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(upiLink)}
            alt="UPI QR Code" className="w-44 h-44 rounded-lg" style={{ border: "1px solid " + C.border }} />
        </div>

        <p className="text-xs" style={{ color: C.textMuted }}>Payment करने के बाद, Transaction ID (UTR) यहां डालें:</p>
        <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="Transaction ID / UTR"
          className="px-3 py-2 rounded-lg outline-none text-sm" style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />

        <button onClick={placeUpiOrder} disabled={placing}
          className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-medium text-sm disabled:opacity-50"
          style={{ background: "#2BA84A", color: "#FFFFFF" }}>
          {placing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Place Order"}
        </button>
      </div>
    );
  }

  return null;
}

// ─── Product card & detail ────────────────────────────────────────────────────
function ProductCard({ product, onOpen }) {
  const [cardCopied, setCardCopied] = useState(false);

  const handleCardShare = async (e) => {
    e.stopPropagation();
    const productUrl = window.location.origin + import.meta.env.BASE_URL + "?product=" + product.id;
    const shareData = { title: product.name, text: product.name + " · ₹" + product.price, url: productUrl };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (err) { /* cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(productUrl);
        setCardCopied(true);
        setTimeout(() => setCardCopied(false), 1500);
      } catch (err) {
        alert("Link: " + productUrl);
      }
    }
  };

  return (
    <button onClick={() => onOpen(product)}
      className="text-left rounded-2xl overflow-hidden transition-transform hover:-translate-y-1 relative"
      style={{ background: C.card, border: "1px solid " + C.border }}>
      <div className="aspect-square overflow-hidden relative">
        <img src={product.img} alt={product.name} className="w-full h-full object-cover" />
        <div onClick={handleCardShare}
          className="absolute top-2 right-2 p-1.5 rounded-full"
          style={{ background: "rgba(0,0,0,0.45)" }}>
          {cardCopied ? <Check className="w-3.5 h-3.5" style={{ color: "#FFFFFF" }} /> : <Share2 className="w-3.5 h-3.5" style={{ color: "#FFFFFF" }} />}
        </div>
      </div>
      <div className="p-3">
        <p className="font-semibold text-[15px]" style={{ color: C.textHeading }}>{product.name}</p>
        <p className="text-xs flex items-center gap-1 mt-0.5" style={{ color: C.textMuted }}>
          <MapPin className="w-3 h-3" /> {product.village} {product.pincode ? "· " + product.pincode : ""}
        </p>
        <div className="flex items-baseline justify-between mt-2">
          <p className="font-bold" style={{ color: C.accent }}>&#x20B9;{product.price}</p>
          <p className="text-xs" style={{ color: C.textMuted }}>{product.unit}</p>
        </div>
      </div>
    </button>
  );
}

function ImageCarousel({ images, alt }) {
  const [idx, setIdx] = useState(0);
  const list = images && images.length ? images : [];
  if (list.length === 0) return null;

  const prev = () => setIdx((i) => (i === 0 ? list.length - 1 : i - 1));
  const next = () => setIdx((i) => (i === list.length - 1 ? 0 : i + 1));

  return (
    <div className="rounded-2xl overflow-hidden mb-4 max-w-md mx-auto relative" style={{ border: "1px solid " + C.border }}>
      <img src={list[idx]} alt={alt} className="w-full aspect-square object-cover" />
      {list.length > 1 && (
        <>
          <button onClick={prev} className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full"
            style={{ background: "rgba(0,0,0,0.4)" }}>
            <ArrowLeft className="w-4 h-4" style={{ color: "#FFFFFF" }} />
          </button>
          <button onClick={next} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full rotate-180"
            style={{ background: "rgba(0,0,0,0.4)" }}>
            <ArrowLeft className="w-4 h-4" style={{ color: "#FFFFFF" }} />
          </button>
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
            {list.map((_, i) => (
              <button key={i} onClick={() => setIdx(i)} className="w-1.5 h-1.5 rounded-full"
                style={{ background: i === idx ? "#FFFFFF" : "rgba(255,255,255,0.5)" }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProductDetail({ product, onBack }) {
  const [copied, setCopied] = useState(false);
  const productUrl = window.location.origin + import.meta.env.BASE_URL + "?product=" + product.id;

  const handleShare = async () => {
    const shareData = {
      title: product.name,
      text: product.name + " — " + (product.maker || "") + " · ₹" + product.price,
      url: productUrl,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (e) { /* user cancelled, ignore */ }
    } else {
      try {
        await navigator.clipboard.writeText(productUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (e) {
        alert("Link: " + productUrl);
      }
    }
  };

  return (
    <div className="px-4 py-5">
      <div className="flex items-center justify-between mb-4">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm" style={{ color: C.accent }}>
          <ArrowLeft className="w-4 h-4" /> वापस जाएं
        </button>
        <button onClick={handleShare} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg"
          style={{ background: C.accentSoft, color: C.accent }}>
          {copied ? "✓ Link Copy हुआ" : (<><Share2 className="w-3.5 h-3.5" /> Share करें</>)}
        </button>
      </div>
      <ImageCarousel images={product.images && product.images.length ? product.images : (product.img ? [product.img] : [])} alt={product.name} />
      <div className="max-w-md mx-auto">
        <h2 className="text-xl font-bold mb-1" style={{ color: C.textHeading, fontFamily: "Georgia, serif" }}>{product.name}</h2>
        <p className="text-sm flex items-center gap-1 mb-2" style={{ color: C.textMuted }}>
          <MapPin className="w-3.5 h-3.5" /> {product.maker} · {product.village} {product.pincode ? "· पिनकोड " + product.pincode : ""}
        </p>
        <p className="text-sm mb-4 leading-relaxed" style={{ color: C.textBody }}>{product.desc}</p>
        <div className="flex items-baseline gap-2 mb-5">
          <p className="text-2xl font-bold" style={{ color: C.accent }}>&#x20B9;{product.price}</p>
          <p className="text-sm" style={{ color: C.textMuted }}>/ {product.unit}</p>
        </div>
        <div className="flex flex-col gap-3">
          <OrderNow product={product} />
          <ChatWithSellerLink product={product} />
        </div>
      </div>
    </div>
  );
}

// ─── Auth screens ─────────────────────────────────────────────────────────────
function LoginScreen({ onCancel, onShowRegister }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError("");
    try { await signInWithEmailAndPassword(auth, email, pw); }
    catch (e) { setError("Login fail हुआ — email/password check करें।"); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-5" style={{ background: C.bg }}>
      <div className="w-full max-w-sm p-6 rounded-2xl" style={{ background: C.card, border: "1px solid " + C.border }}>
        <div className="flex items-center gap-2 mb-4">
          <Lock className="w-5 h-5" style={{ color: C.accent }} />
          <p className="font-semibold" style={{ color: C.textHeading }}>Login करें</p>
        </div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email"
          className="w-full px-4 py-2.5 rounded-xl outline-none text-sm mb-2"
          style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="Password"
          className="w-full px-4 py-2.5 rounded-xl outline-none text-sm mb-2"
          style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
        {error && <p className="text-xs mb-2" style={{ color: "#B83A2A" }}>{error}</p>}
        <button onClick={submit} disabled={busy}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium mb-2 disabled:opacity-50"
          style={{ background: C.accent, color: "#FFFFFF" }}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Login करें
        </button>
        <button onClick={onShowRegister} className="w-full text-xs mb-3" style={{ color: C.accent }}>
          नया विक्रेता हूं — Register करें
        </button>
        <button onClick={onCancel} className="w-full text-xs" style={{ color: C.textMuted }}>
          वापस website पर जाएं
        </button>
      </div>
    </div>
  );
}

function RegisterScreen({ onDone, onCancel }) {
  const [form, setForm] = useState({ name: "", village: "", pincode: "", phone: "", upiId: "", email: "", pw: "" });
  const [payStatus, setPayStatus] = useState(PAYMENT_ENABLED ? "idle" : "paid");
  const [rzpResponse, setRzpResponse] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handlePay = () => {
    setPayStatus("paying");
    payWithRazorpay({
      amount: MONTHLY_FEE,
      name: form.name,
      description: "Registration Shulk - Mitti Ki Dukan",
      onSuccess: (response) => {
        setRzpResponse(response);
        setPayStatus("paid");
      },
      onFail: (reason) => {
        setPayStatus("failed");
        setError("Payment " + (reason === "cancelled" ? "cancel कर दी" : "fail हुई") + " — फिर से try करें।");
      },
    });
  };

  const submit = async () => {
    if (!form.name || !form.village || !form.pincode || !form.email || !form.pw) {
      setError("कृपया सभी ज़रूरी fields भरें।"); return;
    }
    if (payStatus !== "paid") {
      setError("कृपया पहले ₹" + MONTHLY_FEE + " payment करें।"); return;
    }
    setBusy(true); setError("");
    try {
      const cred = await createUserWithEmailAndPassword(auth, form.email, form.pw);
      await setDoc(doc(db, "vendors", cred.user.uid), {
        name: form.name, village: form.village, pincode: form.pincode,
        phone: form.phone, upiId: form.upiId, email: form.email,
        status: "pending",
        lastPaymentClaim: new Date().toISOString(),
        lastTxnId: rzpResponse?.razorpay_payment_id || "razorpay",
        paymentVerified: true,
      });
      onDone();
    } catch (e) {
      setError("Registration fail हुआ — शायद ये email पहले से इस्तेमाल हो रहा है।");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-5 py-10" style={{ background: C.bg }}>
      <div className="w-full max-w-sm p-6 rounded-2xl" style={{ background: C.card, border: "1px solid " + C.border }}>
        <div className="flex items-center gap-2 mb-4">
          <UserPlus className="w-5 h-5" style={{ color: C.accent }} />
          <p className="font-semibold" style={{ color: C.textHeading }}>विक्रेता Registration</p>
        </div>
        <div className="flex flex-col gap-2 mb-3">
          {[
            { key: "name", placeholder: "आपका नाम" },
            { key: "village", placeholder: "गांव/area" },
            { key: "pincode", placeholder: "पिनकोड" },
            { key: "phone", placeholder: "मोबाइल नंबर (WhatsApp)" },
            { key: "upiId", placeholder: "UPI ID (जैसे: name@paytm)" },
            { key: "email", placeholder: "Email", type: "email" },
            { key: "pw", placeholder: "Password बनाएं", type: "password" },
          ].map((f) => (
            <input key={f.key} type={f.type || "text"} value={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="px-4 py-2.5 rounded-xl outline-none text-sm"
              style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
          ))}
        </div>

        {/* ── Subscription Info ─────────────────────────────── */}
        <div className="p-3 rounded-xl mb-3 text-xs" style={{ background: C.accentSoft, color: C.textBody }}>
          <p className="font-semibold mb-1" style={{ color: C.textHeading }}>🎉 Seller Registration – FREE</p>
          <p className="mb-1">✅ Mitti Ki Dukaan par apni online dukaan banana bilkul FREE hai.</p>
          <p className="mb-1">📢 Agar aap future me Facebook/Instagram par apne area me promotion karwana chahte hain, to woh ek optional paid marketing service hogi.</p>
          <p>💰 Sabhi orders ka payment seedha aapke UPI account me jayega. Mitti Ki Dukaan koi commission nahi leti.</p>
        </div>

        {/* ── Payment Section ────────────────────────────────── */}
        {PAYMENT_ENABLED ? (
          <div className="p-3 rounded-xl mb-3" style={{ background: C.card, border: "1px solid " + C.border }}>
            <p className="text-xs font-semibold mb-2" style={{ color: C.textHeading }}>
              पहले &#x20B9;{MONTHLY_FEE} pay करें (ज़रूरी):
            </p>
            {payStatus === "paid" ? (
              <div className="flex items-center gap-2 p-3 rounded-xl" style={{ background: "#DCF3DD", color: "#226B2E" }}>
                <Check className="w-5 h-5" />
                <div>
                  <p className="text-sm font-semibold">Payment सफल!</p>
                  <p className="text-xs">ID: {rzpResponse?.razorpay_payment_id}</p>
                </div>
              </div>
            ) : (
              <button
                onClick={handlePay}
                disabled={payStatus === "paying"}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-medium text-sm disabled:opacity-50"
                style={{ background: C.accent, color: "#FFFFFF" }}
              >
                {payStatus === "paying" ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                {payStatus === "paying" ? "Payment खुल रही है..." : "&#x20B9;" + MONTHLY_FEE + " Pay करें"}
              </button>
            )}
            {payStatus === "failed" && (
              <p className="text-xs mt-2 text-center" style={{ color: "#B83A2A" }}>Payment fail हुई — फिर से try करें।</p>
            )}
          </div>
        ) : null}
        <button onClick={submit} disabled={busy || payStatus !== "paid"}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium mb-2 disabled:opacity-40"
          style={{ background: C.accent, color: "#FFFFFF" }}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Register करें
        </button>
        <p className="text-xs mb-3 text-center" style={{ color: C.textMuted }}>
          Registration के बाद Society verify करके approve करेगी।
        </p>
        <button onClick={onCancel} className="w-full text-xs" style={{ color: C.textMuted }}>
          वापस जाएं
        </button>
      </div>
    </div>
  );
}

function PendingApprovalScreen({ onExit }) {
  return (
    <div className="min-h-screen w-full flex items-center justify-center px-5" style={{ background: C.bg }}>
      <div className="w-full max-w-sm p-6 rounded-2xl text-center" style={{ background: C.card, border: "1px solid " + C.border }}>
        <Clock className="w-8 h-8 mx-auto mb-3" style={{ color: C.accent }} />
        <p className="font-semibold mb-2" style={{ color: C.textHeading }}>Approval का इंतज़ार है</p>
        <p className="text-sm mb-4" style={{ color: C.textBody }}>
          आपकी registration और payment मिल गई है। Society की टीम जल्द ही verify करके approve करेगी।
        </p>
        <button onClick={onExit} className="text-sm" style={{ color: C.accent }}>Logout करें</button>
      </div>
    </div>
  );
}

// ─── Vendor Panel ─────────────────────────────────────────────────────────────
const emptyForm = { name: "", price: "", unit: "", category: "अचार", img: "", images: [], desc: "" };
const MAX_PRODUCT_IMAGES = 4;

function VendorPanel({ vendor, products, addProduct, updateProduct, removeProduct, ownerId, onExit, reloadVendor }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [upiInput, setUpiInput] = useState(vendor.upiId || "");
  const [phoneInput, setPhoneInput] = useState(vendor.phone || "");
  const [nameInput, setNameInput] = useState(vendor.name || "");
  const [villageInput, setVillageInput] = useState(vendor.village || "");
  const [pincodeInput, setPincodeInput] = useState(vendor.pincode || "");
  const [savingUpi, setSavingUpi] = useState(false);
  const [claimingPay, setClaimingPay] = useState(false);
  const [storeCopied, setStoreCopied] = useState(false);
  const [sharedProductId, setSharedProductId] = useState(null);
  const [orderTab, setOrderTab] = useState("pending");
  const myOrders = useSellerOrders(ownerId);

  const handleShareProduct = async (p) => {
    const productUrl = window.location.origin + import.meta.env.BASE_URL + "?product=" + p.id;
    const shareData = { title: p.name, text: p.name + " — " + vendor.name + " · ₹" + p.price, url: productUrl };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (e) { /* cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(productUrl);
        setSharedProductId(p.id);
        setTimeout(() => setSharedProductId(null), 2000);
      } catch (e) {
        alert("Link: " + productUrl);
      }
    }
  };

  const storeUrl = window.location.origin + import.meta.env.BASE_URL + "?vendor=" + ownerId;
  const promotionWaLink = "https://wa.me/" + SOCIETY_WHATSAPP + "?text=" +
    encodeURIComponent("नमस्ते! मैं " + vendor.name + " हूं (" + vendor.village + ")। मुझे अपने products के लिए Facebook/Instagram Promotion Package के बारे में जानकारी चाहिए।");
  const handleShareStore = async () => {
    const shareData = { title: vendor.name + " की दुकान", text: "मिट्टी की दुकान पर " + vendor.name + " के products देखें", url: storeUrl };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (e) { /* cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(storeUrl);
        setStoreCopied(true);
        setTimeout(() => setStoreCopied(false), 2000);
      } catch (e) {
        alert("Link: " + storeUrl);
      }
    }
  };

  const myProducts = products.filter((p) => p.ownerId === ownerId);

  const daysSincePaid = vendor.lastPaymentClaim
    ? Math.floor((Date.now() - new Date(vendor.lastPaymentClaim).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const reminderDue = daysSincePaid !== null && daysSincePaid >= 26;
  const overdue = daysSincePaid !== null && daysSincePaid >= 30;

  const feeUpiLink = "upi://pay?pa=" + encodeURIComponent(SOCIETY_UPI_ID) +
    "&pn=" + encodeURIComponent("Thrive Skills Society") +
    "&am=" + MONTHLY_FEE + "&cu=INR&tn=" + encodeURIComponent("Masik Shulk - " + vendor.name);

  const whatsappReminderLink = "https://wa.me/91" + (vendor.phone || "").replace(/\D/g, "") +
    "?text=" + encodeURIComponent("नमस्ते " + vendor.name + "! हमारी मिट्टी की दुकान platform का ₹100 मासिक शुल्क देय है। कृपया " + SOCIETY_UPI_ID + " पर pay करें और हमें Transaction ID भेजें। धन्यवाद — Thrive Skills Society");

  const handlePhotoSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadToCloudinary(file);
      setForm((f) => {
        const nextImages = [...(f.images || []), url].slice(0, MAX_PRODUCT_IMAGES);
        return { ...f, images: nextImages, img: nextImages[0] || url };
      });
    } catch { alert("फोटो upload नहीं हो पाई, फिर से try करें।"); }
    finally { setUploading(false); e.target.value = ""; }
  };

  const removeFormImage = (idx) => {
    setForm((f) => {
      const nextImages = (f.images || []).filter((_, i) => i !== idx);
      return { ...f, images: nextImages, img: nextImages[0] || "" };
    });
  };

  const saveUpi = async () => {
    if (!nameInput.trim() || !villageInput.trim() || !pincodeInput.trim()) {
      alert("नाम, गांव/area और पिनकोड खाली नहीं रह सकते।");
      return;
    }
    setSavingUpi(true);
    try {
      const updatedFields = {
        name: nameInput.trim(),
        village: villageInput.trim(),
        pincode: pincodeInput.trim(),
        upiId: upiInput,
        phone: phoneInput,
      };
      await updateDoc(doc(db, "vendors", ownerId), updatedFields);

      // vendor ki purani details jo products mein save thi (maker/village/pincode/upiId/sellerPhone),
      // unko bhi naye details se sync karo taaki listing pe purana naam na dikhे
      const myOwnProducts = products.filter((p) => p.ownerId === ownerId);
      for (const p of myOwnProducts) {
        await updateDoc(doc(db, "products", p.id), {
          maker: updatedFields.name,
          village: updatedFields.village,
          pincode: updatedFields.pincode,
          upiId: updatedFields.upiId,
          sellerPhone: updatedFields.phone,
        });
      }

      if (reloadVendor) await reloadVendor();
    } finally { setSavingUpi(false); }
  };

  const claimPaid = async () => {
    setClaimingPay(true);
    try {
      await updateDoc(doc(db, "vendors", ownerId), { lastPaymentClaim: new Date().toISOString() });
      if (reloadVendor) await reloadVendor();
    } finally { setClaimingPay(false); }
  };

  const [orderBusyId, setOrderBusyId] = useState(null);
  const changeOrderStatus = async (orderId, fields, confirmMsg) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setOrderBusyId(orderId);
    try { await updateOrderStatus(orderId, fields); }
    catch (e) { alert("Order update नहीं हो पाया: " + e.message); }
    finally { setOrderBusyId(null); }
  };
  const verifyPayment = (o) => changeOrderStatus(o.id, { paymentStatus: "paid", status: "pending" });
  const acceptOrder = (o) => changeOrderStatus(o.id, { status: "accepted" });
  const rejectOrder = (o) => changeOrderStatus(o.id, { status: "rejected" }, "क्या आप वाकई इस order को reject करना चाहते हैं?");
  const packOrder = (o) => changeOrderStatus(o.id, { status: "packed" });
  const shipOrder = (o) => changeOrderStatus(o.id, { status: "out_for_delivery" });
  const deliverOrder = (o) => changeOrderStatus(o.id, { status: "delivered" });
  const cancelOrder = (o) => changeOrderStatus(o.id, { status: "cancelled" }, "क्या आप वाकई इस order को cancel करना चाहते हैं?");

  const startNew = () => { setForm(emptyForm); setEditing("new"); };
  const startEdit = (p) => { setForm({ ...p, images: p.images && p.images.length ? p.images : (p.img ? [p.img] : []) }); setEditing(p.id); };

  const handleSave = async () => {
    if (!form.name || !form.price) return;
    setBusy(true);
    try {
      const fullData = { ...form, maker: vendor.name, village: vendor.village, pincode: vendor.pincode, upiId: vendor.upiId || "", sellerPhone: vendor.phone || "" };
      if (editing === "new") await addProduct(fullData, ownerId);
      else await updateProduct(editing, fullData);
      setEditing(null);
    } finally { setBusy(false); }
  };

  const handleDelete = async (id) => {
    if (confirm("क्या आप वाकई इस product को हटाना चाहते हैं?")) await removeProduct(id);
  };

  return (
    <div className="min-h-screen w-full" style={{ background: C.bg }}>
      <div className="px-5 py-4" style={{ background: C.accent }}>
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div>
            <p className="font-semibold" style={{ color: "#FFFFFF" }}>{vendor.name} का पैनल</p>
            <p className="text-[11px]" style={{ color: "rgba(242,226,213,0.8)" }}>{vendor.village} · {vendor.pincode}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleShareStore} className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg"
              style={{ background: "rgba(255,255,255,0.15)", color: "#FFFFFF" }}>
              <Share2 className="w-3.5 h-3.5" /> {storeCopied ? "✓ Copy हुआ" : "दुकान Share करें"}
            </button>
            <button onClick={onExit} className="flex items-center gap-1.5 text-sm" style={{ color: "#F2E2D5" }}>
              <LogOut className="w-4 h-4" /> Logout
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-5 pt-5">
        {/* Reminder Banner */}
        {reminderDue && (
          <div className="p-3 rounded-xl mb-4 text-sm font-medium"
            style={overdue
              ? { background: "#FBE2DD", color: "#B83A2A", border: "1px solid #B83A2A" }
              : { background: "#FFF3CD", color: "#7A5A00", border: "1px solid #E0B400" }}>
            {overdue
              ? "तारीख निकल गई है — कृपया जल्दी ₹" + MONTHLY_FEE + " pay करें, वरना products बंद हो सकते हैं।"
              : "Reminder: " + (30 - daysSincePaid) + " दिन बचे हैं — कृपया ₹" + MONTHLY_FEE + " का नया भुगतान कर दें।"}
          </div>
        )}

        {/* Profile / UPI */}
        <div className="flex flex-col gap-2 p-3 rounded-xl mb-4" style={{ background: C.card, border: "1px solid " + C.border }}>
          <p className="text-xs font-semibold" style={{ color: C.textMuted }}>अपनी details update करें</p>
          <input value={nameInput} onChange={(e) => setNameInput(e.target.value)}
            placeholder="आपका नाम"
            className="px-3 py-2 rounded-lg outline-none text-sm"
            style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
          <div className="flex gap-2">
            <input value={villageInput} onChange={(e) => setVillageInput(e.target.value)}
              placeholder="गांव/area"
              className="flex-1 px-3 py-2 rounded-lg outline-none text-sm"
              style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
            <input value={pincodeInput} onChange={(e) => setPincodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="पिनकोड" inputMode="numeric"
              className="w-28 px-3 py-2 rounded-lg outline-none text-sm"
              style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
          </div>
          <input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)}
            placeholder="WhatsApp/मोबाइल नंबर (10 digit)"
            className="px-3 py-2 rounded-lg outline-none text-sm"
            style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
          <div className="flex gap-2">
            <input value={upiInput} onChange={(e) => setUpiInput(e.target.value)}
              placeholder="UPI ID (जैसे: name@paytm)"
              className="flex-1 px-3 py-2 rounded-lg outline-none text-sm"
              style={{ background: C.bg, border: "1px solid " + C.border, color: C.textBody }} />
            <button onClick={saveUpi} disabled={savingUpi}
              className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              style={{ background: C.accent, color: "#FFFFFF" }}>
              {savingUpi ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
            </button>
          </div>
          {savingUpi && <p className="text-[11px]" style={{ color: C.textMuted }}>Profile और आपके सभी products update हो रहे हैं...</p>}
        </div>

        {/* Monthly Fee */}
        <div className="p-4 rounded-xl mb-4" style={{ background: C.accentSoft, border: "1px solid " + C.accent }}>
          <p className="font-semibold text-sm mb-1" style={{ color: C.textHeading }}>Subscription Status</p>
          {PAYMENT_ENABLED ? (
            <>
              <p className="text-xs mb-1" style={{ color: C.textBody }}>
                ये पैसा Society आपके products की Facebook/Instagram पर Ads चलाने में खर्च करती है।
              </p>
              <p className="text-xs mb-3" style={{ color: C.textBody }}>
                {vendor.lastPaymentClaim
                  ? "आख़िरी payment claim: " + new Date(vendor.lastPaymentClaim).toLocaleDateString("hi-IN")
                  : "अभी तक कोई payment claim नहीं है।"}
              </p>
              <div className="flex flex-col items-center gap-2 mb-3">
                <a href={feeUpiLink}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm w-full"
                  style={{ background: C.accent, color: "#FFFFFF" }}>
                  <CreditCard className="w-4 h-4" /> UPI से &#x20B9;{MONTHLY_FEE} Pay करें
                </a>
                <img src={"https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=" + encodeURIComponent(feeUpiLink)}
                  alt="Fee QR" className="w-32 h-32 rounded-lg" style={{ border: "1px solid " + C.border }} />
              </div>
              <button onClick={claimPaid} disabled={claimingPay}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }}>
                {claimingPay ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} मैंने Pay कर दिया
              </button>
            </>
          ) : (
            <div className="flex items-start gap-2">
              <span className="text-lg">🎉</span>
              <div className="flex-1">
                <p className="text-sm font-semibold" style={{ color: "#226B2E" }}>Mitti Ki Dukaan हमेशा FREE है!</p>
                <p className="text-xs mt-0.5 mb-3" style={{ color: C.textBody }}>
                  आपकी online दुकान बनाना और चलाना बिल्कुल मुफ़्त है। Mitti Ki Dukaan कोई commission नहीं लेती — सभी orders का payment सीधे आपके UPI account में जाता है।
                </p>
                <a href={promotionWaLink} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-medium"
                  style={{ background: "#2BA84A", color: "#FFFFFF" }}>
                  <MessageCircle className="w-3.5 h-3.5" /> Facebook/Instagram Promotion चाहिए? Contact करें
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Orders */}
        <div className="p-4 rounded-xl mb-4" style={{ background: C.card, border: "1px solid " + C.border }}>
          <div className="flex items-center gap-2 mb-3">
            <ShoppingBasket className="w-4 h-4" style={{ color: C.accent }} />
            <p className="font-semibold text-sm" style={{ color: C.textHeading }}>Orders ({myOrders.length})</p>
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3">
            {ORDER_TABS.map((t) => {
              const count = myOrders.filter((o) => t.key === "cancelled_rejected" ? (o.status === "cancelled" || o.status === "rejected") : o.status === t.key).length;
              return (
                <button key={t.key} onClick={() => setOrderTab(t.key)}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium"
                  style={orderTab === t.key ? { background: C.accent, color: "#FFFFFF" } : { background: C.bg, border: "1px solid " + C.border, color: C.textBody }}>
                  {t.label} ({count})
                </button>
              );
            })}
          </div>

          <div className="flex flex-col gap-3">
            {myOrders
              .filter((o) => orderTab === "cancelled_rejected" ? (o.status === "cancelled" || o.status === "rejected") : o.status === orderTab)
              .map((o) => (
                <div key={o.id} className="p-3 rounded-xl" style={{ background: C.bg, border: "1px solid " + C.border }}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <p className="font-medium text-sm" style={{ color: C.textHeading }}>{o.productName} × {o.quantity}</p>
                      <p className="text-xs" style={{ color: C.textMuted }}>&#x20B9;{o.amount} · {o.paymentMethod === "upi" ? "UPI Prepaid" : "Cash on Delivery"}</p>
                    </div>
                    <OrderStatusBadge status={o.status} />
                  </div>
                  <p className="text-xs" style={{ color: C.textBody }}>{o.customerName} · {o.customerPhone}</p>
                  <p className="text-xs mb-2" style={{ color: C.textMuted }}>{o.customerAddress} · पिनकोड {o.customerPincode}</p>
                  {o.paymentMethod === "upi" && o.utr && (
                    <p className="text-xs mb-2 font-medium px-2 py-1 rounded inline-block" style={{ background: "#DCF3DD", color: "#226B2E" }}>
                      UTR: {o.utr}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 mt-1">
                    {o.status === "payment_pending" && (
                      <button onClick={() => verifyPayment(o)} disabled={orderBusyId === o.id}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: "#DCF3DD", color: "#226B2E" }}>
                        Payment Verify करें (Paid mark करें)
                      </button>
                    )}
                    {o.status === "pending" && (
                      <>
                        <button onClick={() => acceptOrder(o)} disabled={orderBusyId === o.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: "#DCF3DD", color: "#226B2E" }}>Accept</button>
                        <button onClick={() => rejectOrder(o)} disabled={orderBusyId === o.id}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: "#FBE2DD", color: "#B83A2A" }}>Reject</button>
                      </>
                    )}
                    {o.status === "accepted" && (
                      <button onClick={() => packOrder(o)} disabled={orderBusyId === o.id}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: C.accentSoft, color: C.accent }}>Packed करें</button>
                    )}
                    {o.status === "packed" && (
                      <button onClick={() => shipOrder(o)} disabled={orderBusyId === o.id}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: C.accentSoft, color: C.accent }}>Out for Delivery करें</button>
                    )}
                    {o.status === "out_for_delivery" && (
                      <button onClick={() => deliverOrder(o)} disabled={orderBusyId === o.id}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: "#DCF3DD", color: "#226B2E" }}>Delivered करें</button>
                    )}
                    {!["delivered", "cancelled", "rejected"].includes(o.status) && (
                      <button onClick={() => cancelOrder(o)} disabled={orderBusyId === o.id}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50" style={{ background: C.bg, border: "1px solid " + C.border, color: C.textMuted }}>Cancel</button>
                    )}
                  </div>
                </div>
              ))}
            {myOrders.filter((o) => orderTab === "cancelled_rejected" ? (o.status === "cancelled" || o.status === "rejected") : o.status === orderTab).length === 0 && (
              <p className="text-sm" style={{ color: C.textMuted }}>इस category में कोई order नहीं है।</p>
            )}
          </div>
        </div>

        {/* Products */}
        {editing === null && (
          <div>
            <button onClick={startNew}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium mb-4"
              style={{ background: C.accent, color: "#FFFFFF" }}>
              <Plus className="w-4 h-4" /> नया Product जोड़ें
            </button>
            <div className="flex flex-col gap-2">
              {myProducts.map((p) => (
                <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl"
                  style={{ background: C.card, border: "1px solid " + C.border }}>
                  <img src={p.img} alt={p.name} className="w-12 h-12 rounded-lg object-cover" />
                  <div className="flex-1">
                    <p className="font-medium text-sm" style={{ color: C.textHeading }}>{p.name}</p>
                    <p className="text-xs" style={{ color: C.textMuted }}>&#x20B9;{p.price}</p>
                  </div>
                  <button onClick={() => handleShareProduct(p)} className="p-2 rounded-lg" style={{ background: "#DCF3DD", color: "#226B2E" }} title="Product Share करें">
                    {sharedProductId === p.id ? <Check className="w-4 h-4" /> : <Share2 className="w-4 h-4" />}
                  </button>
                  <button onClick={() => startEdit(p)} className="p-2 rounded-lg" style={{ background: C.accentSoft, color: C.accent }}>
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(p.id)} className="p-2 rounded-lg" style={{ background: "#FBE2DD", color: "#B83A2A" }}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {myProducts.length === 0 && (
                <p className="text-sm text-center py-6" style={{ color: C.textMuted }}>अभी कोई product नहीं है।</p>
              )}
            </div>
          </div>
        )}

        {editing !== null && (
          <div className="flex flex-col gap-3">
            <p className="font-semibold mb-1" style={{ color: C.textHeading }}>
              {editing === "new" ? "नया Product" : "Product Edit करें"}
            </p>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Product का नाम"
              className="px-4 py-2.5 rounded-xl outline-none text-sm" style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }} />
            <input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="कीमत (₹)"
              className="px-4 py-2.5 rounded-xl outline-none text-sm" style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }} />
            <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="Unit (जैसे: 1 किलो)"
              className="px-4 py-2.5 rounded-xl outline-none text-sm" style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }} />
            <div>
              <label className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm cursor-pointer"
                style={{ background: C.accentSoft, color: C.accent, border: "1px dashed " + C.accent, opacity: (form.images || []).length >= MAX_PRODUCT_IMAGES ? 0.5 : 1 }}>
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {uploading ? "Upload हो रहा है..." : "गैलरी से फोटो चुनें (" + (form.images || []).length + "/" + MAX_PRODUCT_IMAGES + ")"}
                <input type="file" accept="image/*" onChange={handlePhotoSelect} className="hidden" disabled={uploading || (form.images || []).length >= MAX_PRODUCT_IMAGES} />
              </label>
              <p className="text-[11px] mt-1" style={{ color: C.textMuted }}>पहली फोटो main image होगी। एक से ज़्यादा फोटो डालने पर customer को carousel दिखेगा।</p>
              {(form.images || []).length > 0 && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {form.images.map((url, idx) => (
                    <div key={idx} className="relative">
                      <img src={url} alt={"preview " + idx} className="w-20 h-20 rounded-lg object-cover"
                        style={idx === 0 ? { border: "2px solid " + C.accent } : { border: "1px solid " + C.border }} />
                      <button onClick={() => removeFormImage(idx)}
                        className="absolute -top-1.5 -right-1.5 rounded-full p-0.5" style={{ background: "#B83A2A" }}>
                        <X className="w-3 h-3" style={{ color: "#FFFFFF" }} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="px-4 py-2.5 rounded-xl outline-none text-sm" style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <textarea value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} placeholder="Description"
              className="px-4 py-2.5 rounded-xl outline-none text-sm resize-none" rows={3}
              style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }} />
            <div className="flex gap-3 mt-2">
              <button onClick={handleSave} disabled={busy}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50"
                style={{ background: C.accent, color: "#FFFFFF" }}>
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save करें
              </button>
              <button onClick={() => setEditing(null)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }}>
                <X className="w-4 h-4" /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Super Admin Panel ────────────────────────────────────────────────────────
function StatCard({ icon, label, value, tint }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-2xl" style={{ background: C.card, border: "1px solid " + C.border }}>
      <div className="p-2.5 rounded-xl shrink-0" style={{ background: tint.bg, color: tint.fg }}>
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold leading-none" style={{ color: C.textHeading }}>{value}</p>
        <p className="text-xs mt-0.5" style={{ color: C.textMuted }}>{label}</p>
      </div>
    </div>
  );
}

// Clickable version of StatCard — tab navigation ke liye
function TabButton({ icon, label, value, tint, active, onClick }) {
  return (
    <button onClick={onClick} className="flex items-center gap-3 p-4 rounded-2xl text-left transition"
      style={{ background: active ? C.accentSoft : C.card, border: "1.5px solid " + (active ? C.accent : C.border) }}>
      <div className="p-2.5 rounded-xl shrink-0" style={{ background: tint.bg, color: tint.fg }}>
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold leading-none" style={{ color: active ? C.accent : C.textHeading }}>{value}</p>
        <p className="text-xs mt-0.5" style={{ color: active ? C.accent : C.textMuted }}>{label}</p>
      </div>
    </button>
  );
}

function SectionHeader({ icon, title, count, tint }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="p-1.5 rounded-lg" style={{ background: tint.bg, color: tint.fg }}>{icon}</div>
      <p className="font-semibold" style={{ color: C.textHeading }}>{title}</p>
      <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: C.accentSoft, color: C.accent }}>
        {count}
      </span>
    </div>
  );
}

function SuperAdminPanel({ vendors, reloadVendors, products, removeProduct, onExit, adminUid }) {
  const [busyId, setBusyId] = useState(null);
  const [search, setSearch] = useState("");
  const [expandedVendor, setExpandedVendor] = useState(null);
  const [activeTab, setActiveTab] = useState("pending");
  const [orderTab, setOrderTab] = useState("pending");
  const adminOrders = useAllOrders(true);

  const approve = async (uid) => {
    setBusyId(uid);
    try { await updateDoc(doc(db, "vendors", uid), { status: "approved" }); await reloadVendors(); }
    finally { setBusyId(null); }
  };

  const reject = async (uid) => {
    if (!confirm("क्या आप वाकई इस registration को reject करना चाहते हैं?")) return;
    setBusyId(uid);
    try { await updateDoc(doc(db, "vendors", uid), { status: "rejected" }); await reloadVendors(); }
    finally { setBusyId(null); }
  };

  const removeVendor = async (uid) => {
    if (!confirm("क्या आप वाकई इस विक्रेता को हटाना चाहते हैं? इसके सारे products भी हट जाएंगे।")) return;
    setBusyId(uid);
    try {
      const theirProducts = products.filter((p) => p.ownerId === uid);
      for (const p of theirProducts) await deleteDoc(doc(db, "products", p.id));
      await deleteDoc(doc(db, "vendors", uid));
      await reloadVendors();
    } finally { setBusyId(null); }
  };

  const handleRemoveProduct = async (id) => {
    if (!confirm("क्या आप वाकई इस product को हटाना चाहते हैं?")) return;
    await removeProduct(id);
  };

  const pending = vendors.filter((v) => v.status === "pending");
  const approved = vendors.filter((v) => v.status === "approved");

  const q = search.trim().toLowerCase();
  const filteredApproved = q
    ? approved.filter((v) => (v.name || "").toLowerCase().includes(q) || (v.village || "").toLowerCase().includes(q))
    : approved;
  const filteredProducts = (expandedVendor ? products.filter((p) => p.ownerId === expandedVendor) : products)
    .filter((p) => !q || (p.name || "").toLowerCase().includes(q) || (p.maker || "").toLowerCase().includes(q));

  const reminderCount = approved.filter((v) => {
    const days = v.lastPaymentClaim ? Math.floor((Date.now() - new Date(v.lastPaymentClaim).getTime()) / (1000 * 60 * 60 * 24)) : null;
    return days !== null && days >= 26;
  }).length;

  const expandedVendorObj = expandedVendor ? approved.find((v) => v.uid === expandedVendor) : null;

  return (
    <div className="min-h-screen w-full" style={{ background: C.bg }}>
      <div className="px-5 py-4" style={{ background: C.accent }}>
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4" style={{ color: "#FFFFFF" }} />
            <p className="font-semibold" style={{ color: "#FFFFFF" }}>Super Admin · Thrive Skills Society</p>
          </div>
          <button onClick={onExit} className="flex items-center gap-1.5 text-sm" style={{ color: "#F2E2D5" }}>
            <LogOut className="w-4 h-4" /> Logout
          </button>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-5">
        {/* Tabs — click karke sirf wahi section dikhega */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <TabButton active={activeTab === "pending"} onClick={() => setActiveTab("pending")}
            icon={<Clock className="w-4 h-4" />} label="Pending Approval" value={pending.length}
            tint={{ bg: "#FCEFC7", fg: "#8A6A00" }} />
          <TabButton active={activeTab === "vendors"} onClick={() => setActiveTab("vendors")}
            icon={<UserPlus className="w-4 h-4" />} label="Approved विक्रेता" value={approved.length}
            tint={{ bg: "#DCF3DD", fg: "#226B2E" }} />
          <TabButton active={activeTab === "products"} onClick={() => setActiveTab("products")}
            icon={<ShoppingBasket className="w-4 h-4" />} label="कुल Products" value={products.length}
            tint={{ bg: "#E4E8FB", fg: "#33429E" }} />
          <TabButton active={activeTab === "orders"} onClick={() => setActiveTab("orders")}
            icon={<ShoppingBasket className="w-4 h-4" />} label="Orders" value={adminOrders.length}
            tint={{ bg: "#F0E6FA", fg: "#6B3FA0" }} />
        </div>

        {reminderCount > 0 && activeTab !== "vendors" && (
          <button onClick={() => setActiveTab("vendors")}
            className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl mb-6 text-left"
            style={{ background: "#FBE2DD", border: "1px solid #E0B400" }}>
            <MessageCircle className="w-4 h-4 shrink-0" style={{ color: "#B83A2A" }} />
            <p className="text-xs font-medium" style={{ color: "#B83A2A" }}>
              {reminderCount} विक्रेता का Payment Reminder due है — देखने के लिए यहाँ क्लिक करें
            </p>
          </button>
        )}

        {/* Search — pending tab mein search nahi chahiye, baaki sab mein chahiye */}
        {activeTab !== "pending" && (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl mb-6" style={{ background: C.card, border: "1px solid " + C.border }}>
            <Search className="w-4 h-4" style={{ color: C.textMuted }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={activeTab === "vendors" ? "विक्रेता खोजें..." : activeTab === "products" ? "Product खोजें..." : "..."}
              className="flex-1 outline-none text-sm bg-transparent" style={{ color: C.textBody }} />
            {search && (
              <button onClick={() => setSearch("")} style={{ color: C.textMuted }}><X className="w-4 h-4" /></button>
            )}
          </div>
        )}

        {/* Orders tab */}
        {activeTab === "orders" && (
          <div>
            <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4">
              {ORDER_TABS.map((t) => {
                const count = adminOrders.filter((o) => t.key === "cancelled_rejected" ? (o.status === "cancelled" || o.status === "rejected") : o.status === t.key).length;
                return (
                  <button key={t.key} onClick={() => setOrderTab(t.key)}
                    className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium"
                    style={orderTab === t.key ? { background: C.accent, color: "#FFFFFF" } : { background: C.card, border: "1px solid " + C.border, color: C.textBody }}>
                    {t.label} ({count})
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-3">
              {adminOrders
                .filter((o) => orderTab === "cancelled_rejected" ? (o.status === "cancelled" || o.status === "rejected") : o.status === orderTab)
                .filter((o) => !search || (o.productName || "").toLowerCase().includes(search.toLowerCase()) || (o.customerName || "").toLowerCase().includes(search.toLowerCase()) || (o.sellerName || "").toLowerCase().includes(search.toLowerCase()))
                .map((o) => (
                  <div key={o.id} className="p-3 rounded-xl" style={{ background: C.card, border: "1px solid " + C.border }}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <p className="font-medium text-sm" style={{ color: C.textHeading }}>{o.productName} × {o.quantity}</p>
                        <p className="text-xs" style={{ color: C.textMuted }}>विक्रेता: {o.sellerName} · &#x20B9;{o.amount} · {o.paymentMethod === "upi" ? "UPI" : "COD"}</p>
                      </div>
                      <OrderStatusBadge status={o.status} />
                    </div>
                    <p className="text-xs" style={{ color: C.textBody }}>Customer: {o.customerName} · {o.customerPhone}</p>
                  </div>
                ))}
              {adminOrders.filter((o) => orderTab === "cancelled_rejected" ? (o.status === "cancelled" || o.status === "rejected") : o.status === orderTab).length === 0 && (
                <p className="text-sm" style={{ color: C.textMuted }}>इस category में कोई order नहीं है।</p>
              )}
            </div>
          </div>
        )}

        {/* Pending approvals tab */}
        {activeTab === "pending" && (
          <div className="grid sm:grid-cols-2 gap-3">
            {pending.map((v) => (
              <div key={v.uid} className="p-4 rounded-2xl" style={{ background: C.card, border: "1px solid #E0B400" }}>
                <p className="font-medium text-sm" style={{ color: C.textHeading }}>{v.name}</p>
                <p className="text-xs mb-2" style={{ color: C.textMuted }}>{v.village} · पिनकोड {v.pincode} · {v.phone} · {v.email}</p>
                {v.lastTxnId && (
                  <p className="text-xs mb-3 font-medium px-2 py-1 rounded inline-block" style={{ background: "#DCF3DD", color: "#226B2E" }}>
                    Transaction ID: {v.lastTxnId}
                  </p>
                )}
                <div className="flex gap-2">
                  <button onClick={() => approve(v.uid)} disabled={busyId === v.uid}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                    style={{ background: "#DCF3DD", color: "#226B2E" }}>
                    {busyId === v.uid ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve करें
                  </button>
                  <button onClick={() => reject(v.uid)} disabled={busyId === v.uid}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                    style={{ background: "#FBE2DD", color: "#B83A2A" }}>
                    <X className="w-3.5 h-3.5" /> Reject करें
                  </button>
                </div>
              </div>
            ))}
            {pending.length === 0 && (
              <p className="text-sm sm:col-span-2" style={{ color: C.textMuted }}>अभी कोई pending request नहीं है।</p>
            )}
          </div>
        )}

        {/* Approved vendors tab */}
        {activeTab === "vendors" && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredApproved.map((v) => {
              const count = products.filter((p) => p.ownerId === v.uid).length;
              const days = v.lastPaymentClaim
                ? Math.floor((Date.now() - new Date(v.lastPaymentClaim).getTime()) / (1000 * 60 * 60 * 24))
                : null;
              const needsReminder = days !== null && days >= 26;
              const isExpanded = expandedVendor === v.uid;
              const waReminder = "https://wa.me/91" + (v.phone || "").replace(/\D/g, "") +
                "?text=" + encodeURIComponent("नमस्ते " + v.name + "! मिट्टी की दुकान का ₹100 मासिक शुल्क देय है। " + SOCIETY_UPI_ID + " पर pay करें और Transaction ID भेजें। धन्यवाद!");
              return (
                <div key={v.uid} className="p-4 rounded-2xl flex flex-col gap-3"
                  style={{ background: C.card, border: "1px solid " + (needsReminder ? "#E0B400" : isExpanded ? C.accent : C.border) }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate" style={{ color: C.textHeading }}>{v.name}</p>
                      <p className="text-xs mt-0.5" style={{ color: C.textMuted }}>{v.village}</p>
                    </div>
                    <button onClick={() => removeVendor(v.uid)} disabled={busyId === v.uid}
                      className="p-1.5 rounded-lg shrink-0 disabled:opacity-50" style={{ background: "#FBE2DD", color: "#B83A2A" }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <p className="text-xs" style={{ color: C.textMuted }}>
                    {v.lastPaymentClaim ? "payment: " + new Date(v.lastPaymentClaim).toLocaleDateString("hi-IN") : "कोई payment नहीं"}
                    {days !== null ? " (" + days + " दिन पहले)" : ""}
                  </p>

                  {needsReminder && v.phone && (
                    <a href={waReminder} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded self-start"
                      style={{ background: "#DCF3DD", color: "#226B2E" }}>
                      <MessageCircle className="w-3 h-3" /> WhatsApp Reminder भेजें
                    </a>
                  )}

                  <button onClick={() => { setExpandedVendor(v.uid); setActiveTab("products"); }}
                    className="flex items-center justify-between text-xs font-medium px-3 py-1.5 rounded-lg mt-auto"
                    style={{ background: C.accentSoft, color: C.accent }}>
                    <span>{count} Products देखें</span>
                    <span>→</span>
                  </button>
                </div>
              );
            })}
            {filteredApproved.length === 0 && (
              <p className="text-sm sm:col-span-2 lg:col-span-3" style={{ color: C.textMuted }}>कोई विक्रेता नहीं मिला।</p>
            )}
          </div>
        )}

        {/* Products tab */}
        {activeTab === "products" && (
          <div>
            {expandedVendorObj && (
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium" style={{ color: C.textHeading }}>{expandedVendorObj.name} के Products</p>
                <button onClick={() => setExpandedVendor(null)} className="text-xs font-medium inline-flex items-center gap-1" style={{ color: C.accent }}>
                  <X className="w-3.5 h-3.5" /> Filter हटाएं
                </button>
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {filteredProducts.map((p) => (
                <div key={p.id} className="rounded-2xl overflow-hidden flex flex-col"
                  style={{ background: C.card, border: "1px solid " + C.border }}>
                  <img src={p.img} alt={p.name} className="w-full h-28 object-cover" />
                  <div className="p-3 flex flex-col gap-1 flex-1">
                    <p className="font-medium text-sm leading-tight" style={{ color: C.textHeading }}>{p.name}</p>
                    <p className="text-xs" style={{ color: C.textMuted }}>{p.maker}</p>
                    <div className="flex items-center justify-between mt-auto pt-2">
                      <span className="text-sm font-bold" style={{ color: C.accent }}>&#x20B9;{p.price}</span>
                      <button onClick={() => handleRemoveProduct(p.id)} className="p-1.5 rounded-lg" style={{ background: "#FBE2DD", color: "#B83A2A" }}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {filteredProducts.length === 0 && (
                <p className="text-sm col-span-2 sm:col-span-3 lg:col-span-4" style={{ color: C.textMuted }}>कोई product नहीं मिला।</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MyOrdersModal({ onClose }) {
  const orders = useMyOrders();
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full sm:max-w-md h-[85vh] sm:h-[600px] rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden" style={{ background: C.bg }}>
        <div className="px-4 py-3 flex items-center justify-between shrink-0" style={{ background: C.accent }}>
          <p className="font-semibold text-sm" style={{ color: "#FFFFFF" }}>मेरे Orders</p>
          <button onClick={onClose}><X className="w-5 h-5" style={{ color: "#FFFFFF" }} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {orders.length === 0 && (
            <p className="text-sm text-center mt-8" style={{ color: C.textMuted }}>अभी कोई order नहीं है। कोई product order करने पर वो यहां दिखेगा।</p>
          )}
          {orders.map((o) => (
            <div key={o.id} className="p-3 rounded-xl" style={{ background: C.card, border: "1px solid " + C.border }}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="font-medium text-sm" style={{ color: C.textHeading }}>{o.productName} × {o.quantity}</p>
                <OrderStatusBadge status={o.status} />
              </div>
              <p className="text-xs" style={{ color: C.textMuted }}>
                विक्रेता: {o.sellerName} · &#x20B9;{o.amount} · {o.paymentMethod === "upi" ? "UPI Prepaid" : "Cash on Delivery"}
              </p>
              {o.paymentMethod === "upi" && (
                <p className="text-xs mt-1" style={{ color: C.textMuted }}>Payment: {o.paymentStatus === "paid" ? "✓ Paid" : "Verification Pending"}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function ArtisanMarket() {
  const { products, loading, error, addProduct, updateProduct, removeProduct } = useProducts();
  const { user, authLoading } = useAuthUser();
  const { vendor, vendorLoading, reloadVendor } = useVendor(user);
  const { vendors, reload: reloadVendors } = useAllVendors();

  const [selected, setSelected] = useState(null);
  const [category, setCategory] = useState("सभी");
  const [query, setQuery] = useState("");
  const [pincodeQuery, setPincodeQuery] = useState("");
  const [authView, setAuthView] = useState(null);
  const [storeFilter, setStoreFilter] = useState(null); // shared "Share Store" link se aaya vendor uid
  const [appCopied, setAppCopied] = useState(false);

  const handleShareApp = async () => {
    const siteUrl = window.location.origin + import.meta.env.BASE_URL;
    const shareData = { title: "हमारी मिट्टी की दुकान", text: "आपके ज़िले के कारीगरों के असली, घर के बने प्रोडक्ट — देखिए और ऑर्डर करिए!", url: siteUrl };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch (e) { /* cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(siteUrl);
        setAppCopied(true);
        setTimeout(() => setAppCopied(false), 2000);
      } catch (e) {
        alert("Link: " + siteUrl);
      }
    }
  };

  const [showMyOrders, setShowMyOrders] = useState(false);

  const allCategories = ["सभी", ...CATEGORIES];

  // Shared link se aaya "?product=ID" ya "?vendor=UID" — products load hote hi apply karo
  useEffect(() => {
    if (loading || products.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const productId = params.get("product");
    const vendorUid = params.get("vendor");
    if (productId) {
      const p = products.find((pr) => pr.id === productId);
      if (p) setSelected(p);
    } else if (vendorUid) {
      setStoreFilter(vendorUid);
    }
  }, [loading, products]);

  const filtered = products.filter((p) =>
    (category === "सभी" || p.category === category) &&
    (!pincodeQuery || p.pincode === pincodeQuery) &&
    (!storeFilter || p.ownerId === storeFilter) &&
    (!query || p.name?.includes(query) || p.maker?.includes(query) || p.village?.includes(query))
  );

  if (loading || authLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center" style={{ background: C.bg }}>
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: C.accent }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center px-5" style={{ background: C.bg }}>
        <div className="max-w-sm p-5 rounded-xl text-sm text-center" style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }}>{error}</div>
      </div>
    );
  }

  if (authView === "login" && (!user || user.isAnonymous)) return <LoginScreen onCancel={() => setAuthView(null)} onShowRegister={() => setAuthView("register")} />;
  if (authView === "register" && (!user || user.isAnonymous)) return <RegisterScreen onDone={() => setAuthView(null)} onCancel={() => setAuthView("login")} />;

  if (user && user.email === SUPER_ADMIN_EMAIL) {
    return <SuperAdminPanel vendors={vendors} reloadVendors={reloadVendors} products={products} removeProduct={removeProduct} onExit={() => signOut(auth)} adminUid={user.uid} />;
  }

  if (user && !user.isAnonymous && !vendorLoading) {
    if (!vendor || vendor.status === "pending") return <PendingApprovalScreen onExit={() => signOut(auth)} />;
    if (vendor.status === "rejected") {
      return (
        <div className="min-h-screen w-full flex items-center justify-center px-5" style={{ background: C.bg }}>
          <div className="max-w-sm p-6 rounded-2xl text-center" style={{ background: C.card, border: "1px solid " + C.border }}>
            <p className="text-sm mb-4" style={{ color: C.textBody }}>माफ़ करें, आपकी registration approve नहीं हो पाई। ज़्यादा जानकारी के लिए Society से संपर्क करें।</p>
            <button onClick={() => signOut(auth)} className="text-sm" style={{ color: C.accent }}>Logout करें</button>
          </div>
        </div>
      );
    }
    if (vendor.status === "approved") {
      return <VendorPanel vendor={vendor} products={products} addProduct={addProduct} updateProduct={updateProduct} removeProduct={removeProduct} ownerId={user.uid} onExit={() => signOut(auth)} reloadVendor={reloadVendor} />;
    }
  }

  if (selected) {
    return (
      <div className="min-h-screen w-full" style={{ background: C.bg }}>
        <div className="max-w-2xl mx-auto">
          <ProductDetail product={selected} onBack={() => setSelected(null)} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full" style={{ background: C.bg }}>
      {/* Header */}
      <div className="px-6 py-5" style={{ background: C.accent }}>
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <ShoppingBasket className="w-5 h-5" style={{ color: "#FFFFFF" }} />
              <h1 className="text-xl font-bold" style={{ color: "#FFFFFF", fontFamily: "Georgia, serif" }}>हमारी मिट्टी की दुकान</h1>
            </div>
            <p className="text-sm mb-0.5" style={{ color: "#F2E2D5" }}>आपके ज़िले के कारीगरों के असली, घर के बने प्रोडक्ट</p>
            <p className="text-xs" style={{ color: "rgba(242,226,213,0.75)" }}>एक पहल — Thrive Skills Educational Society · Powered by Hector365</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleShareApp} className="p-2 rounded-lg" style={{ background: "rgba(255,255,255,0.15)" }} title="Website Share करें">
              {appCopied ? <Check className="w-4 h-4" style={{ color: "#FFFFFF" }} /> : <Share2 className="w-4 h-4" style={{ color: "#FFFFFF" }} />}
            </button>
            <button onClick={() => setAuthView("login")} className="p-2 rounded-lg" style={{ background: "rgba(255,255,255,0.15)" }}>
              <Lock className="w-4 h-4" style={{ color: "#FFFFFF" }} />
            </button>
          </div>
        </div>
      </div>

      {/* Shared Store link se aaye ho to banner dikhao */}
      {storeFilter && (
        <div className="max-w-6xl mx-auto px-5 pt-4">
          <div className="flex items-center justify-between gap-2 px-4 py-2.5 rounded-xl" style={{ background: C.accentSoft }}>
            <p className="text-sm" style={{ color: C.accent }}>
              आप एक विक्रेता की दुकान देख रहे हैं ({filtered.length} products)
            </p>
            <button onClick={() => { setStoreFilter(null); window.history.replaceState({}, "", window.location.pathname); }}
              className="text-xs font-medium px-3 py-1 rounded-lg shrink-0" style={{ background: C.accent, color: "#FFFFFF" }}>
              सभी Products देखें
            </button>
          </div>
        </div>
      )}

      {/* Search + Pincode */}
      <div className="max-w-6xl mx-auto px-5 py-4 flex gap-2">
        <div className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded-xl" style={{ background: C.card, border: "1px solid " + C.border }}>
          <Search className="w-4 h-4" style={{ color: C.textMuted }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Product, गांव या नाम खोजें..."
            className="flex-1 outline-none text-sm bg-transparent" style={{ color: C.textBody }} />
        </div>
        <input value={pincodeQuery} onChange={(e) => setPincodeQuery(e.target.value)} placeholder="पिनकोड"
          className="w-28 px-3 py-2.5 rounded-xl outline-none text-sm"
          style={{ background: C.card, border: "1px solid " + C.border, color: C.textBody }} />
      </div>

      {/* Categories */}
      <div className="max-w-6xl mx-auto flex gap-2 px-5 pb-2 overflow-x-auto">
        {allCategories.map((c) => (
          <button key={c} onClick={() => setCategory(c)}
            className="px-4 py-1.5 rounded-full text-sm whitespace-nowrap shrink-0"
            style={category === c ? { background: C.accent, color: "#FFFFFF" } : { background: C.card, color: C.textBody, border: "1px solid " + C.border }}>
            {c}
          </button>
        ))}
      </div>

      {/* Products Grid */}
      <div className="max-w-6xl mx-auto grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {filtered.map((p) => <ProductCard key={p.id} product={p} onOpen={setSelected} />)}
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-sm py-10" style={{ color: C.textMuted }}>कोई product नहीं मिला।</p>
      )}

      <p className="text-xs text-center py-6" style={{ color: C.textMuted }}>
        Thrive Skills Educational Society की एक पहल · Technology Partner: Hector365
      </p>

      {/* Floating "मेरे Orders" Button */}
      <button onClick={() => setShowMyOrders(true)}
        className="fixed bottom-5 right-5 flex items-center gap-2 px-4 py-3 rounded-full shadow-lg z-40"
        style={{ background: C.accent, color: "#FFFFFF" }}>
        <ShoppingBasket className="w-4 h-4" /> <span className="text-sm font-medium">मेरे Orders</span>
      </button>

      {showMyOrders && <MyOrdersModal onClose={() => setShowMyOrders(false)} />}
    </div>
  );
}
