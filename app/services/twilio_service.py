import logging
from typing import Optional

import httpx

from app.core.config import settings

logging.basicConfig(level=logging.INFO)

TWILIO_API_URL = (
    f"https://api.twilio.com/2010-04-01/Accounts/"
    f"{settings.twilio_account_sid}/Messages.json"
)


def send_whatsapp(message: str) -> bool:
    """
    Sends a WhatsApp notification using Twilio.

    Returns:
        True  -> Message sent successfully
        False -> Failed
    """

    if not all((settings.twilio_account_sid, settings.twilio_auth_token,
                settings.twilio_whatsapp_number, settings.user_whatsapp_number)):
        logging.info("WhatsApp notifications are not configured; skipping.")
        return False

    try:

        response = httpx.post(
            TWILIO_API_URL,
            data={
                "From": settings.twilio_whatsapp_number,
                "To": settings.user_whatsapp_number,
                "Body": message,
            },
            auth=(
                settings.twilio_account_sid,
                settings.twilio_auth_token,
            ),
            timeout=20,
        )

        response.raise_for_status()

        logging.info("✅ WhatsApp notification sent.")

        return True

    except Exception as e:

        logging.exception(f"Twilio Error: {e}")

        return False


def send_incident_notification(
    incident_id: str,
    repository: str,
    file_name: str,
    status: str,
    pull_request_url: Optional[str] = None,
    branch_name: Optional[str] = None,
):
    """
    Sends a formatted BLUEFIST incident report to WhatsApp.
    """

    message = f"""
🚨 BLUEFIST Autonomous Incident Report

🆔 Incident
{incident_id}

📦 Repository
{repository}

📄 File
{file_name}

✅ Status
{status}
"""

    if branch_name:
        message += f"\n🌿 Branch\n{branch_name}\n"

    if pull_request_url:
        message += f"\n🔗 Pull Request\n{pull_request_url}\n"

    message += """

🤖 Workflow

✔ AST Generated
✔ AI Patch Synthesized
✔ Sandbox Validation Completed
✔ GitHub PR Created

BLUEFIST Autonomous Site Reliability Engine
"""

    return send_whatsapp(message.strip())
