/* =========================================================
   PayBuddy: Firebase configuration
   =========================================================
   1. Go to https://console.firebase.google.com
   2. Create a project (or use an existing one)
   3. Build > Firestore Database > Create database (start in
      "production mode" is fine, see README for security rules)
   4. Project settings (gear icon) > General > "Your apps" >
      Add app > Web (</>) > register app
   5. Copy the firebaseConfig object it gives you and paste the
      values below.
   ========================================================= */

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase (compat SDK, loaded via <script> tags in the HTML files)
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

/* Collections used throughout the app:
   - "customers"    : one doc per customer, doc id = 11-digit account number
   - "transactions" : one doc per payment, shared history for both parties
   - "admins"       : one doc per admin login (see README to seed the first admin)
*/
