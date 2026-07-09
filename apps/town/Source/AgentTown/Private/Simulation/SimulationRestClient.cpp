#include "Simulation/SimulationRestClient.h"
#include "Simulation/SimSnapshotParser.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

void FSimulationRestClient::Configure(const FString& InApiBase, const FString& InAccessToken)
{
	ApiBase = InApiBase;
	AccessToken = InAccessToken;
	while (ApiBase.EndsWith(TEXT("/")))
	{
		ApiBase.LeftChopInline(1);
	}
}

FString FSimulationRestClient::BuildUrl(const FString& Path) const
{
	FString NormalizedPath = Path;
	if (!NormalizedPath.StartsWith(TEXT("/")))
	{
		NormalizedPath = TEXT("/") + NormalizedPath;
	}
	return ApiBase + NormalizedPath;
}

void FSimulationRestClient::ApplyAuth(TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request) const
{
	if (!AccessToken.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *AccessToken));
	}
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetHeader(TEXT("Accept"), TEXT("application/json"));
}

void FSimulationRestClient::SetError(const FString& Message)
{
	LastError = Message;
	UE_LOG(LogTemp, Warning, TEXT("SimulationRestClient: %s"), *Message);
}

void FSimulationRestClient::CreateRun(const FString& Scenario, FOnSimCreateRunComplete OnComplete)
{
	const FString Url = BuildUrl(TEXT("/v1/simulation/runs"));
	const FString Body = FString::Printf(TEXT("{\"scenario\":\"%s\"}"), *Scenario);

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("POST"));
	ApplyAuth(Request);
	Request->SetContentAsString(Body);

	Request->OnProcessRequestComplete().BindLambda(
		[this, OnComplete](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			FSimCreateRunResult Result;
			if (!bConnected || !Response.IsValid())
			{
				SetError(TEXT("CreateRun: no response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (Response->GetResponseCode() < 200 || Response->GetResponseCode() >= 300)
			{
				SetError(FString::Printf(TEXT("CreateRun HTTP %d: %s"),
					Response->GetResponseCode(), *Response->GetContentAsString()));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (!FSimSnapshotParser::ParseCreateRunResponse(Response->GetContentAsString(), Result))
			{
				SetError(TEXT("CreateRun: failed to parse response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			OnComplete.ExecuteIfBound(true, Result);
		});

	if (!Request->ProcessRequest())
	{
		SetError(TEXT("CreateRun: failed to start request"));
		FSimCreateRunResult Empty;
		OnComplete.ExecuteIfBound(false, Empty);
	}
}

void FSimulationRestClient::AdvanceTick(const FString& RunId, FOnSimAdvanceTickComplete OnComplete)
{
	const FString Url = BuildUrl(FString::Printf(TEXT("/v1/simulation/runs/%s/tick"), *RunId));

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("POST"));
	ApplyAuth(Request);
	Request->SetContentAsString(TEXT("{}"));

	Request->OnProcessRequestComplete().BindLambda(
		[this, OnComplete](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			FSimAdvanceTickResult Result;
			if (!bConnected || !Response.IsValid())
			{
				SetError(TEXT("AdvanceTick: no response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (Response->GetResponseCode() < 200 || Response->GetResponseCode() >= 300)
			{
				SetError(FString::Printf(TEXT("AdvanceTick HTTP %d: %s"),
					Response->GetResponseCode(), *Response->GetContentAsString()));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (!FSimSnapshotParser::ParseAdvanceTickResponse(Response->GetContentAsString(), Result))
			{
				SetError(TEXT("AdvanceTick: failed to parse response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			OnComplete.ExecuteIfBound(true, Result);
		});

	if (!Request->ProcessRequest())
	{
		SetError(TEXT("AdvanceTick: failed to start request"));
		FSimAdvanceTickResult Empty;
		OnComplete.ExecuteIfBound(false, Empty);
	}
}

void FSimulationRestClient::GetTickSnapshot(
	const FString& RunId,
	int32 TickNumber,
	FOnSimTickFrameComplete OnComplete)
{
	const FString Url = BuildUrl(FString::Printf(
		TEXT("/v1/simulation/runs/%s/ticks/%d"), *RunId, TickNumber));

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	ApplyAuth(Request);

	Request->OnProcessRequestComplete().BindLambda(
		[this, OnComplete](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			FSimTickFrameResult Result;
			if (!bConnected || !Response.IsValid())
			{
				SetError(TEXT("GetTickSnapshot: no response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (Response->GetResponseCode() < 200 || Response->GetResponseCode() >= 300)
			{
				SetError(FString::Printf(TEXT("GetTickSnapshot HTTP %d: %s"),
					Response->GetResponseCode(), *Response->GetContentAsString()));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (!FSimSnapshotParser::ParseTickFrameResponse(Response->GetContentAsString(), Result))
			{
				SetError(TEXT("GetTickSnapshot: failed to parse response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			OnComplete.ExecuteIfBound(true, Result);
		});

	if (!Request->ProcessRequest())
	{
		SetError(TEXT("GetTickSnapshot: failed to start request"));
		FSimTickFrameResult Empty;
		OnComplete.ExecuteIfBound(false, Empty);
	}
}

void FSimulationRestClient::GetManifest(const FString& RunId, FOnSimManifestComplete OnComplete)
{
	const FString Url = BuildUrl(FString::Printf(TEXT("/v1/simulation/runs/%s/manifest"), *RunId));

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	ApplyAuth(Request);

	Request->OnProcessRequestComplete().BindLambda(
		[this, OnComplete](FHttpRequestPtr /*Req*/, FHttpResponsePtr Response, bool bConnected)
		{
			FSimManifestResult Result;
			if (!bConnected || !Response.IsValid())
			{
				SetError(TEXT("GetManifest: no response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (Response->GetResponseCode() < 200 || Response->GetResponseCode() >= 300)
			{
				SetError(FString::Printf(TEXT("GetManifest HTTP %d: %s"),
					Response->GetResponseCode(), *Response->GetContentAsString()));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			if (!FSimSnapshotParser::ParseManifestResponse(Response->GetContentAsString(), Result))
			{
				SetError(TEXT("GetManifest: failed to parse response"));
				OnComplete.ExecuteIfBound(false, Result);
				return;
			}

			OnComplete.ExecuteIfBound(true, Result);
		});

	if (!Request->ProcessRequest())
	{
		SetError(TEXT("GetManifest: failed to start request"));
		FSimManifestResult Empty;
		OnComplete.ExecuteIfBound(false, Empty);
	}
}
