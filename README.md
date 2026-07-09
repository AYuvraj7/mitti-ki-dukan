# हमारी मिट्टी की दुकान — Setup और Deploy करने के Steps

ये version **असली database (Firebase)** इस्तेमाल करता है — इसलिए admin login और products का data **असली website पर भी ठीक से काम करेगा** (पहले वाले prototype जैसा नहीं टूटेगा)।

---

## Step 1: Firebase Project बनाएं (Free, कोई card नहीं चाहिए)

1. https://console.firebase.google.com पर जाएं, Google account से login करें
2. **"Add project"** दबाएं, कोई नाम दें (जैसे `artisan-market`)
3. Google Analytics का सवाल आए तो "Skip" कर सकते हैं
4. Project बन जाने के बाद, **"Web" (</> आइकॉन)** पर क्लिक करें ताकि एक web-app जोड़ें
5. App का nickname दें (जैसे `artisan-web`), "Register app" दबाएं
6. अब एक code block दिखेगा जिसमें `apiKey`, `authDomain`, वगैरह होंगे — **इन सबको copy कर लें**

## Step 2: Config अपने Code में डालें

`src/firebase.js` फाइल खोलें, और जो values Firebase ने दी थीं, उन्हें यहां paste करें:

```js
const firebaseConfig = {
  apiKey: "यहां अपनी key डालें",
  authDomain: "यहां अपनी authDomain डालें",
  projectId: "यहां अपनी projectId डालें",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
};
```

## Step 3: Firestore Database चालू करें

1. Firebase Console के left menu में **"Firestore Database"** पर जाएं
2. **"Create database"** दबाएं
3. Location चुनें (कोई भी nearby, जैसे `asia-south1` अगर दिखे)
4. **"Start in production mode"** चुनें (ज़्यादा सुरक्षित)
5. Database बन जाने के बाद, ऊपर **"Rules"** tab पर जाएं
6. वहां की content हटाकर, इस repo की `firestore.rules` file का content paste करें, **"Publish"** दबाएं

## Step 4: Login (Authentication) चालू करें

1. Firebase Console में **"Authentication"** पर जाएं
2. **"Get started"** दबाएं
3. "Sign-in method" में **"Email/Password"** चुनें, उसे **Enable** करें, Save करें
4. अब **"Users"** tab में जाकर **"Add user"** दबाएं — अपना admin email और password डालें (यही आपका login होगा website के admin panel में)

## Step 5: GitHub पर Code डालें और Deploy करें

1. इस पूरे folder का content अपनी GitHub repository में upload करें
2. `vite.config.js` में `base: "/artisan-market/"` को अपनी repo के नाम से match करें
3. Repository की **Settings → Pages** में जाकर "Source" को **"GitHub Actions"** करें
4. कुछ मिनट बाद website live हो जाएगी

## Step 6: Website Test करें

1. अपनी website खोलें
2. ऊपर right में lock icon दबाएं
3. वही email/password डालें जो Step 4 में बनाया था
4. Admin panel में products add/edit/delete करके देखें — अब ये डेटा **हमेशा के लिए save रहेगा**, browser बंद करने पर भी नहीं मिटेगा

---

## ⚠️ ज़रूरी: Budget Safety (बहुत ज़्यादा इस्तेमाल होने पर पैसे ना लगें)

1. Firebase Console में **"Usage and billing"** पर जाएं
2. वहां एक **Budget Alert** set करें (जैसे ₹500/महीना) — इससे ज़्यादा खर्च होने पर आपको email मिल जाएगा
3. शुरुआत में Firebase का **free (Spark) plan** ही काफी है — हज़ारों users तक कोई दिक्कत नहीं आएगी
4. अगर बहुत ज़्यादा (राष्ट्रीय स्तर तक) traffic आने लगे, तब "Blaze" plan में upgrade करना पड़ सकता है — पर तब तक धीरे-धीरे scale करें, सीधा बहुत बड़े स्तर पर मत जाएं

## Pricing Model (जैसा decide किया)
- कारीगर का पहला महीना **free**
- उसके बाद **₹30/महीना** (society इसे manually track कर सकती है — अभी automatic payment collection इस version में नहीं है, वो अगला कदम होगा अगर चाहिए हो)
