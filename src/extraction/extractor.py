import re
from typing import Optional, List
from dataclasses import dataclass, field
from decimal import Decimal

@dataclass
class ExtractedFields:
    email: Optional[str] = None
    amount_cents: Optional[int] = None
    minutes: Optional[str] = None
    payment_date: Optional[str] = None
    customer_name: Optional[str] = None
    status: Optional[str] = None
    extraction_warnings: List[str] = field(default_factory=list)

class FieldExtractor:
    @staticmethod
    def extract_from_text(raw_text: str, processing_id: str) -> ExtractedFields:
        fields = ExtractedFields()
        
        # Email
        email_match = re.search(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}', raw_text)
        if email_match:
            fields.email = email_match.group(0)
            
        # Amount
        amount_match = re.search(r'\$\s*(\d+(?:\.\d{2})?)', raw_text)
        if amount_match:
            try:
                # Convert to integer cents
                amount_val = Decimal(amount_match.group(1))
                fields.amount_cents = int(amount_val * 100)
            except Exception as e:
                fields.extraction_warnings.append(f"Failed to parse amount: {e}")
                
        # Minutes
        minute_match = re.search(r'\b\d{1,2}:([0-5]\d)(?::[0-5]\d)?\b', raw_text)
        if minute_match:
            fields.minutes = minute_match.group(1)
            
        # Date (simple heuristics)
        date_match = re.search(r'\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b', raw_text)
        if date_match:
            fields.payment_date = date_match.group(0)
            
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
        
        amount_str = ai_json.get('amount')
        if amount_str:
            amount_match = re.search(r'\$?\s*(\d+(?:\.\d{2})?)', str(amount_str))
            if amount_match:
                try:
                    fields.amount_cents = int(Decimal(amount_match.group(1)) * 100)
                except Exception as e:
                    fields.extraction_warnings.append(f"Failed to parse AI amount: {e}")
                    
        fields.minutes = str(ai_json.get('minutes')) if ai_json.get('minutes') is not None else None
        fields.payment_date = ai_json.get('payment_date')
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
        if fields.payment_date: confidence += 0.10
        if fields.status: confidence += 0.05
        
        return min(1.0, confidence)
