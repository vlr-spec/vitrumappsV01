FROM python:3.11-slim-trixie

# Patch OS-level vulnerabilities in the base image
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Set Python environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create a non-root user and give them ownership of the /app directory
RUN adduser --disabled-password --gecos "" appuser && chown -R appuser /app
USER appuser

# Expose port
EXPOSE 8000

# Command to run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
