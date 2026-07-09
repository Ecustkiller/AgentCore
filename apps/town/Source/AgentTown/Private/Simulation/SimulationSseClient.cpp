#include "Simulation/SimulationSseClient.h"
#include "Simulation/SimSnapshotParser.h"
#include "HttpModule.h"
#include "Interfaces/IHttpResponse.h"

void FSimulationSseClient::Configure(
	const FString& InApiBase,
	const FString& InAccessToken,
	const FString& InRunId)
{
	ApiBase = InApiBase;
	AccessToken = InAccessToken;
	RunId = InRunId;
	while (ApiBase.EndsWith(TEXT("/")))
	{
		ApiBase.LeftChopInline(1);
	}
}

void FSimulationSseClient::SetStreamStatus(const FString& Status, const FString& Detail)
{
	StreamStatus = Status;
	OnStreamStatusChanged.Broadcast(Status, Detail);
}

void FSimulationSseClient::Connect()
{
	if (RunId.IsEmpty() || ApiBase.IsEmpty())
	{
		SetStreamStatus(TEXT("error"), TEXT("Missing run id or API base"));
		return;
	}

	Disconnect();

	SetStreamStatus(TEXT("connecting"));
	bConnected = false;
	ReceiveBuffer.Reset();
	LastReceivedBytes = 0;

	const FString Url = ApiBase + FString::Printf(TEXT("/v1/simulation/runs/%s/stream"), *RunId);
	ActiveRequest = FHttpModule::Get().CreateRequest();
	ActiveRequest->SetURL(Url);
	ActiveRequest->SetVerb(TEXT("GET"));
	if (!AccessToken.IsEmpty())
	{
		ActiveRequest->SetHeader(TEXT("Authorization"), FString::Printf(TEXT("Bearer %s"), *AccessToken));
	}
	ActiveRequest->SetHeader(TEXT("Accept"), TEXT("text/event-stream"));

	ActiveRequest->OnRequestProgress64().BindRaw(this, &FSimulationSseClient::HandleRequestProgress);
	ActiveRequest->OnProcessRequestComplete().BindRaw(this, &FSimulationSseClient::HandleRequestComplete);

	if (!ActiveRequest->ProcessRequest())
	{
		SetStreamStatus(TEXT("error"), TEXT("Failed to start SSE request"));
		ActiveRequest.Reset();
	}
}

void FSimulationSseClient::Disconnect()
{
	if (ActiveRequest.IsValid())
	{
		ActiveRequest->CancelRequest();
		ActiveRequest.Reset();
	}

	bConnected = false;
	ReceiveBuffer.Reset();
	LastReceivedBytes = 0;
	SetStreamStatus(TEXT("idle"));
}

void FSimulationSseClient::HandleRequestProgress(
	FHttpRequestPtr Request,
	uint64 /*BytesSent*/,
	uint64 BytesReceived)
{
	if (!Request.IsValid() || Request != ActiveRequest)
	{
		return;
	}

	const FHttpResponsePtr Response = Request->GetResponse();
	if (!Response.IsValid())
	{
		return;
	}

	if (!bConnected)
	{
		bConnected = true;
		SetStreamStatus(TEXT("connected"));
	}

	const TArray<uint8>& Content = Response->GetContent();
	if (Content.Num() <= LastReceivedBytes)
	{
		return;
	}

	const int32 NewBytes = Content.Num() - LastReceivedBytes;
	FUTF8ToTCHAR Convert(
		reinterpret_cast<const ANSICHAR*>(Content.GetData() + LastReceivedBytes),
		NewBytes);
	const FString Chunk(Convert.Length(), Convert.Get());
	LastReceivedBytes = Content.Num();
	AppendAndParseBuffer(Chunk);
}

void FSimulationSseClient::HandleRequestComplete(
	FHttpRequestPtr Request,
	FHttpResponsePtr Response,
	bool bConnectedSuccessfully)
{
	if (!Request.IsValid() || Request != ActiveRequest)
	{
		return;
	}

	if (Response.IsValid() && Response->GetContentLength() > 0)
	{
		AppendAndParseBuffer(Response->GetContentAsString());
	}

	const bool bWasConnected = bConnected;
	bConnected = false;
	ActiveRequest.Reset();

	if (!bConnectedSuccessfully)
	{
		SetStreamStatus(TEXT("error"), TEXT("SSE connection lost"));
		return;
	}

	if (Response.IsValid())
	{
		const int32 Code = Response->GetResponseCode();
		if (Code < 200 || Code >= 300)
		{
			SetStreamStatus(TEXT("error"), FString::Printf(TEXT("SSE HTTP %d"), Code));
			return;
		}
	}

	if (bWasConnected)
	{
		SetStreamStatus(TEXT("idle"));
	}
}

void FSimulationSseClient::AppendAndParseBuffer(const FString& Chunk)
{
	if (Chunk.IsEmpty())
	{
		return;
	}

	ReceiveBuffer += Chunk;
	ParseSseFrames();
}

void FSimulationSseClient::ParseSseFrames()
{
	while (true)
	{
		const int32 FrameEnd = ReceiveBuffer.Find(TEXT("\n\n"));
		if (FrameEnd == INDEX_NONE)
		{
			break;
		}

		const FString Frame = ReceiveBuffer.Left(FrameEnd);
		ReceiveBuffer.RightChopInline(FrameEnd + 2);

		TArray<FString> DataLines;
		TArray<FString> Lines;
		Frame.ParseIntoArrayLines(Lines, false);
		for (const FString& Line : Lines)
		{
			if (Line.StartsWith(TEXT("data:")))
			{
				FString Data = Line.Mid(5);
				if (Data.StartsWith(TEXT(" ")))
				{
					Data.RightChopInline(1);
				}
				DataLines.Add(Data);
			}
		}

		if (DataLines.Num() == 0)
		{
			continue;
		}

		FSimSseEvent Event;
		if (FSimSnapshotParser::ParseSseEventJson(FString::Join(DataLines, TEXT("\n")), Event))
		{
			OnEvent.Broadcast(Event);
		}
	}
}
