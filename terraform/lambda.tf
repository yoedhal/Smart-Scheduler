# API Gateway is now configured with explicit routes + JWT Authorizer.
# This replaces the previous "quick create" approach that used `target`
# and couldn't support per-route authorization.

# --- Lambda Function ---
resource "aws_lambda_function" "api_handler" {
  filename      = "${path.module}/api_deployment.zip"
  function_name = "smart_scheduler_api"
  memory_size                    = 512
  role                           = local.lab_role_arn
  handler                        = "main.handler"
  runtime                        = "python3.12"
  timeout                        = 30
  reserved_concurrent_executions = 8

  environment {
    variables = {
      TABLE_NAME     = aws_dynamodb_table.smart_scheduler_table.name
      AWS_ACCOUNT_ID = data.aws_caller_identity.current.account_id
      FRONTEND_URL   = var.frontend_url
      GOOGLE_CLIENT_ID     = var.google_client_id
      GOOGLE_CLIENT_SECRET = var.google_client_secret
      OPENAI_API_KEY       = var.openai_api_key
      AI_FAIRNESS_MODEL    = "gpt-4.1-mini"
      WEBHOOK_BASE_URL     = aws_apigatewayv2_api.api_gateway.api_endpoint
    }
  }

  source_code_hash = filebase64sha256("${path.module}/api_deployment.zip")
}

# --- API Gateway HTTP API (explicit, no target shortcut) ---
resource "aws_apigatewayv2_api" "api_gateway" {
  name          = "smart_scheduler_api_gw"
  protocol_type = "HTTP"

  cors_configuration {
    allow_credentials = false
    allow_headers     = ["date", "keep-alive", "content-type", "authorization"]
    allow_methods     = ["*"]
    allow_origins     = [var.frontend_url, "http://localhost:5173", "http://localhost:5273"]
    expose_headers    = ["date", "keep-alive"]
    max_age           = 86400
  }

  lifecycle {
    ignore_changes = [target]
  }
}

# $default stage with auto-deploy (equivalent to what "target" created before)
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api_gateway.id
  name        = "$default"
  auto_deploy = true
}

# Lambda proxy integration (payload format 2.0 is needed for JWT claims in requestContext)
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.api_gateway.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api_handler.invoke_arn
  payload_format_version = "2.0"
}

# --- Cognito JWT Authorizer ---
# This is what validates the Bearer token on every protected request.
# API Gateway checks the token against Cognito and injects the user's
# claims (sub, email, etc.) into the Lambda event automatically.
resource "aws_apigatewayv2_authorizer" "cognito_jwt" {
  api_id           = aws_apigatewayv2_api.api_gateway.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "cognito-jwt-authorizer"

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.client.id]
    issuer   = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.user_pool.id}"
  }
}

# --- Protected Routes (require valid JWT) ---
# ANY /{proxy+} catches all /api/* requests
resource "aws_apigatewayv2_route" "protected" {
  api_id             = aws_apigatewayv2_api.api_gateway.id
  route_key          = "ANY /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_jwt.id
}

# --- Public Route (no auth – for health checks) ---
resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.api_gateway.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# --- CORS preflight (no auth) ---
# Explicit OPTIONS route so preflight requests bypass the JWT authorizer on
# ANY /{proxy+}. A method-specific route wins over ANY, so browser preflights
# hit this no-auth route and get a 2xx + CORS headers instead of a 401.
resource "aws_apigatewayv2_route" "options_preflight" {
  api_id    = aws_apigatewayv2_api.api_gateway.id
  route_key = "OPTIONS /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# --- Authenticated dispatch endpoint (no gateway authorizer; self-validates) ---
# Real POST transport for the frontend: Authorization header + JSON body,
# replacing the GET /health query-string tunnel. Uses NONE auth because the
# backend validates the Cognito *access* token itself (cognito-idp:GetUser),
# which the API Gateway JWT authorizer can't do for access tokens.
resource "aws_apigatewayv2_route" "api_proxy" {
  api_id    = aws_apigatewayv2_api.api_gateway.id
  route_key = "POST /api/proxy"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# --- Public Route (no auth – Google Calendar push notifications) ---
resource "aws_apigatewayv2_route" "gcal_webhook" {
  api_id    = aws_apigatewayv2_api.api_gateway.id
  route_key = "POST /webhook/google-calendar"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# --- Lambda Permission ---
resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke_V2"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api_handler.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api_gateway.execution_arn}/*/*"
}

output "api_endpoint_url" {
  value = aws_apigatewayv2_api.api_gateway.api_endpoint
}
