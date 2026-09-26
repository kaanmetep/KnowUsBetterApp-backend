import "dotenv/config";

const baseUrl = process.env.TEST_SERVER_URL || "http://localhost:3000";
const adminSecret = process.env.ADMIN_NOTIFICATIONS_SECRET;
const iosTestDeviceToken = process.env.IOS_TEST_DEVICE_TOKEN;
const appUserId = process.env.PUSH_TEST_APP_USER_ID || "test-user-1";

if (!adminSecret) {
  console.error("Missing ADMIN_NOTIFICATIONS_SECRET in environment.");
  process.exit(1);
}

async function postNewContent(payload) {
  const response = await fetch(`${baseUrl}/admin/notifications/new-content`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": adminSecret,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  return { status: response.status, body: parsed };
}

async function registerTokenIfProvided() {
  if (!iosTestDeviceToken) {
    console.log(
      "IOS_TEST_DEVICE_TOKEN is not set, skipping register-token step.",
    );
    return;
  }

  const response = await fetch(`${baseUrl}/notifications/register-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      appUserId,
      token: iosTestDeviceToken,
      platform: "ios",
      provider: "apns",
    }),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  console.log("\n[register-token] response:");
  console.log(JSON.stringify({ status: response.status, body: parsed }, null, 2));
}

async function run() {
  console.log(`Testing admin push endpoint on: ${baseUrl}`);
  await registerTokenIfProvided();

  const newQuestionsPayload = {
    title: "Test Push",
    body: "Backend push test mesaji",
    type: "new_questions",
  };

  const newCategoryPayload = {
    title: "Yeni kategori",
    body: "deep_talk kategorisine yeni icerik geldi",
    type: "new_category",
    categoryId: "deep_talk",
  };

  const result1 = await postNewContent(newQuestionsPayload);
  console.log("\n[1/2] new_questions response:");
  console.log(JSON.stringify(result1, null, 2));

  const result2 = await postNewContent(newCategoryPayload);
  console.log("\n[2/2] new_category response:");
  console.log(JSON.stringify(result2, null, 2));
}

run().catch((error) => {
  console.error("Admin push test script failed:", error);
  process.exit(1);
});
