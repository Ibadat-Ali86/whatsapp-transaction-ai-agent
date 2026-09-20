import re
from typing import Optional, List
from dataclasses import dataclass, field
from decimal import Decimal

@dataclass
class ExtractedFields:
    email: Optional[str] = None
    transaction_id: Optional[str] = None
    description: Optional[str] = None
    amount_cents: Optional[int] = None
    minutes: Optional[str] = None
    payment_hour: Optional[int] = None
    payment_date: Optional[str] = None
    payment_month: Optional[int] = None
    payment_day: Optional[int] = None
    customer_name: Optional[str] = None
    status: Optional[str] = None
    extraction_warnings: List[str] = field(default_factory=list)

class FieldExtractor:
    @staticmethod
    def _labeled_transaction_id(raw_text: str) -> Optional[str]:
        """Extract a provider reference next to its explicit receipt label.

        Mobile receipt OCR is not layout-stable: Tesseract can emit the value
        before the label even when the image shows label -> value. Restrict
        extraction to the nearest non-empty line on either side of the label
        so arbitrary merchant text is never promoted to a payment ID.
        """
        label_pattern = re.compile(
            r'\b(?:payment\s+(?:identifier|id)|transaction\s+(?:identifier|id))\b',
            re.IGNORECASE,
        )
        token_pattern = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$')

        for label_match in label_pattern.finditer(raw_text):
            inline = re.search(
                r'\s*[:#=-]\s*([A-Za-z0-9][A-Za-z0-9_-]{3,127})',
                raw_text[label_match.end():label_match.end() + 140],
            )
            if inline:
                return inline.group(1)

            lines = raw_text.splitlines()
            label_line = raw_text.count('\n', 0, label_match.start())
            nearby_lines = []
            for offset in (1, -1, 2, -2):
                index = label_line + offset
                if 0 <= index < len(lines):
                    candidate = lines[index].strip().strip(':#=-')
                    if candidate:
                        nearby_lines.append(candidate)
            for candidate in nearby_lines:
                if token_pattern.fullmatch(candidate) and any(char.isdigit() for char in candidate):
                    return candidate
        return None

    @staticmethod
    def _bounded_int(value, minimum: int, maximum: int) -> Optional[int]:
        if isinstance(value, bool) or value is None:
            return None
        try:
            parsed = int(str(value).strip())
        except (TypeError, ValueError):
            return None
        return parsed if minimum <= parsed <= maximum else None

    @staticmethod
    def extract_from_text(raw_text: str, processing_id: str) -> ExtractedFields:
        fields = ExtractedFields()
        
        # Email
        email_match = re.search(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', raw_text)
        if email_match:
            fields.email = email_match.group(0)

        # Payment screenshots commonly label the provider reference as
        # "Payment identifier". Only read an identifier next to an explicit
        # payment/transaction label; never treat an arbitrary OCR token as a
        # transaction ID.
        fields.transaction_id = FieldExtractor._labeled_transaction_id(raw_text)

        # Only capture a description when the receipt/OCR explicitly labels
        # it. Merchant names and free-form surrounding text are not treated as
        # Stripe descriptions because they are commonly shared by payments.
        description_match = re.search(
            r'\bdescription\b\s*[:=-]?\s*(.+)',
            raw_text,
            re.IGNORECASE,
        )
        if description_match:
            description = description_match.group(1).strip()
            if description:
                fields.description = description[:1000]
            
        # Amount
        amount_match = re.search(r'\$\s*(\d+(?:\.\d{2})?)', raw_text)
        if amount_match:
            try:
                # Convert to integer cents
                amount_val = Decimal(amount_match.group(1))
                fields.amount_cents = int(amount_val * 100)
            except Exception as e:
                fields.extraction_warnings.append(f"Failed to parse amount: {e}")
                
        # Payment time. Keep both components for captionless recovery, but only
        # accept times associated with receipt/payment context. This prevents a
        # WhatsApp message timestamp from becoming payment evidence.
        time_matches = list(re.finditer(r'\b(\d{1,2}):([0-5]\d)(?:\s*([AP]M))?\b', raw_text, re.IGNORECASE))
        time_match = next(
            (
                match for match in time_matches
                if re.search(
                    r'(?:today\s+at|processed\s+at|payment\s+time|time|at)\s*[:=]?\s*$',
                    raw_text[max(0, match.start() - 32):match.start()],
                    re.IGNORECASE,
                )
            ),
            None,
        )
        if time_match:
            hour = int(time_match.group(1))
            fields.minutes = time_match.group(2)
            meridiem = (time_match.group(3) or '').upper()
            if meridiem:
                if hour < 1 or hour > 12:
                    fields.extraction_warnings.append('Invalid 12-hour payment time')
                else:
                    if meridiem == 'AM':
                        fields.payment_hour = 0 if hour == 12 else hour
                    else:
                        fields.payment_hour = 12 if hour == 12 else hour + 12
            elif 0 <= hour <= 23:
                fields.payment_hour = hour
            
        # Date (simple heuristics)
        date_match = re.search(r'\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b', raw_text)
        if date_match:
            fields.payment_date = date_match.group(0)
            fields.payment_month = int(fields.payment_date[5:7])
            fields.payment_day = int(fields.payment_date[8:10])
        else:
            month_names = {
                'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
                'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
            }
            month_day_match = re.search(
                r'\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|'
                r'jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+'
                r'(\d{1,2})\b',
                raw_text,
                re.IGNORECASE,
            )
            if month_day_match:
                fields.payment_month = month_names[month_day_match.group(1)[:3].lower()]
                fields.payment_day = int(month_day_match.group(2))
            
        # Status
        status_keywords = ['Completed', 'Success', 'Paid', 'Failed', 'Pending', 'Declined']
        for keyword in status_keywords:
            if re.search(rf'\b{keyword}\b', raw_text, re.IGNORECASE):
                fields.status = keyword
                break
                
        return fields

    @staticmethod
    def extract_from_ai_response(ai_json: dict, processing_id: str) -> ExtractedFields:
        fields = ExtractedFields()
        
        fields.email = ai_json.get('email')
        transaction_id = ai_json.get('transaction_id') or ai_json.get('payment_identifier')
        if transaction_id is not None:
            normalized_transaction_id = str(transaction_id).strip()
            if 4 <= len(normalized_transaction_id) <= 128:
                fields.transaction_id = normalized_transaction_id

        description = ai_json.get('description')
        if description is not None:
            normalized_description = str(description).strip()
            if normalized_description:
                fields.description = normalized_description[:1000]
        
        amount_str = ai_json.get('amount')
        if amount_str:
            amount_match = re.search(r'\$?\s*(\d+(?:\.\d{2})?)', str(amount_str))
            if amount_match:
                try:
                    fields.amount_cents = int(Decimal(amount_match.group(1)) * 100)
                except Exception as e:
                    fields.extraction_warnings.append(f"Failed to parse AI amount: {e}")
                    
        fields.minutes = str(ai_json.get('minutes')) if ai_json.get('minutes') is not None else None
        payment_hour = ai_json.get('payment_hour')
        fields.payment_hour = FieldExtractor._bounded_int(payment_hour, 0, 23)
        fields.payment_date = ai_json.get('payment_date')
        payment_month = ai_json.get('payment_month')
        payment_day = ai_json.get('payment_day')
        fields.payment_month = FieldExtractor._bounded_int(payment_month, 1, 12)
        fields.payment_day = FieldExtractor._bounded_int(payment_day, 1, 31)
        fields.customer_name = ai_json.get('customer_name')
        fields.status = ai_json.get('status')
        
        return fields

    @staticmethod
    def compute_confidence(fields: ExtractedFields) -> float:
        """
        HEURISTIC calculation of extraction confidence.
        Based on weighted field presence.
        """
        confidence = 0.0
        
        if fields.email: confidence += 0.35
        if fields.amount_cents is not None: confidence += 0.35
        if fields.minutes: confidence += 0.15
        if fields.payment_date or (fields.payment_month is not None and fields.payment_day is not None):
            confidence += 0.10
        if fields.status: confidence += 0.05
        
        return min(1.0, confidence)
