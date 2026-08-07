import httpx
from app.core.config import settings

def send_whatsapp(message: str):
    url = f"https://api.twilio.com/2010-04-01/Accounts/{settings.TWILIO_ACCOUNT_SID}/Messages.json"

    httpx.post(
        url,
        data={
            "From": settings.TWILIO_WHATSAPP_NUMBER,
            "To": settings.USER_WHATSAPP_NUMBER,
            "Body": message
        },
        auth=(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
    )