import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp } from "firebase/firestore";

// Firebase config from environment variables
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const initialFAQs = [
  // Registration Fees
  {
    category: "Registration Fees",
    question: "How much does animal registration cost?",
    answer: "Registration fees are $10 for spayed/neutered animals and $100 for unaltered animals. This is an annual fee that must be renewed each year.",
    order: 0,
  },
  {
    category: "Registration Fees", 
    question: "When do I need to register my pet?",
    answer: "All pets must be registered within 30 days of arrival on Saba or when they reach 4 months of age. Registration must be renewed annually.",
    order: 1,
  },
  {
    category: "Registration Fees",
    question: "What payment methods are accepted?",
    answer: "We accept cash, bank transfers, and major credit cards. Payment can be made at our shelter or online through our payment portal.",
    order: 2,
  },
  
  // Getting Animals to SABA
  {
    category: "Getting Animals to SABA",
    question: "How do I transport my pet to Saba?",
    answer: "Pets can travel via WinAir or other regional carriers. You'll need a health certificate from a vet within 10 days of travel, proof of vaccinations, and a valid registration.",
    order: 0,
  },
  {
    category: "Getting Animals to SABA",
    question: "What vaccinations are required?",
    answer: "Dogs need rabies, DHPP, and bordetella. Cats need rabies and FVRCP. All vaccinations must be current and documented.",
    order: 1,
  },
  {
    category: "Getting Animals to SABA",
    question: "Is quarantine required?",
    answer: "No quarantine is required for pets with proper documentation from rabies-free areas. Please contact us for specific requirements based on your origin.",
    order: 2,
  },
  
  // Getting Animals from SABA
  {
    category: "Getting Animals from SABA",
    question: "How do I adopt an animal from SABA?",
    answer: "Start by viewing our available animals online or visiting our shelter. Once you find a pet you're interested in, fill out an adoption application and schedule a meet-and-greet.",
    order: 0,
  },
  {
    category: "Getting Animals from SABA",
    question: "What are the adoption fees?",
    answer: "Adoption fees vary by animal and include spay/neuter, initial vaccinations, and microchipping. Please contact us for current fee information.",
    order: 1,
  },
  {
    category: "Getting Animals from SABA",
    question: "Can you help transport adopted animals off-island?",
    answer: "Yes, we can assist with arranging transport for adopted animals to many destinations. Adopters are responsible for transport costs and travel requirements.",
    order: 2,
  },
  
  // General
  {
    category: "General",
    question: "What are your hours of operation?",
    answer: "Shelter: Monday-Friday 9 AM-6 PM, Saturday 10 AM-4 PM, Closed Sundays. Animal Control: Available 24/7 for emergencies.",
    order: 0,
  },
  {
    category: "General",
    question: "How can I volunteer?",
    answer: "We welcome volunteers! Please visit our shelter to fill out a volunteer application or email us at sfpcasaba@gmail.com. Opportunities include dog walking, cat socialization, and event assistance.",
    order: 1,
  },
  {
    category: "General",
    question: "How can I donate?",
    answer: "You can donate through our website, at our shelter, or via bank transfer. We accept cash, credit cards, and bank transfers. All donations help us care for animals on Saba.",
    order: 2,
  },
];

async function seedFAQs() {
  try {
    console.log("Seeding FAQs to Firestore...");
    
    for (const faq of initialFAQs) {
      await addDoc(collection(db, "faq"), {
        ...faq,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      console.log(`Added FAQ: ${faq.question}`);
    }
    
    console.log("✅ FAQs seeded successfully!");
  } catch (error) {
    console.error("❌ Error seeding FAQs:", error);
  }
}

seedFAQs();
