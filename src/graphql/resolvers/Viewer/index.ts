import { IResolvers } from "@graphql-tools/utils";
import { Viewer, Database, User } from "../../../lib/types";
import { Google,Stripe } from "../../../lib/api";
import { LogInArgs,ConnectStripeArgs} from "./types";
import crypto from "crypto";
import { authorize } from "../../../lib/utils";
import { Response, Request } from "express";

const cookieOptions = {
  httpOnly: true,
  sameSite: true,
  signed: true,
  secure: process.env.NODE_ENV === "development" ? false : true,
};

const logInViaCookie = async (
  token: string,
  db: Database,
  req: Request,
  res: Response
): Promise<User | null> => {
  const updateRes = await db.users.findOneAndUpdate(
    { _id: req.signedCookies.viewer },
    { $set: { token } },

    { returnDocument: "after" }
  );

  let viewer = updateRes.value;

  if (!viewer) {
    res.clearCookie("viewer", cookieOptions);
  }

  return viewer;
};

const logInViaGoogle = async (
  code: string,
  token: string,
  db: Database,
  res: Response
): Promise<User | null> => {
  const { user } = await Google.logIn(code);

  if (!user) {
    throw new Error("Google login error");
  }

  // Name/Photo/Email Lists
  const userNamesList = user.names && user.names.length ? user.names : null;
  
  const userLocationList= user.locations && user.locations ? user.locations: null;
  const userPhotosList = user.photos && user.photos.length ? user.photos : null;
  const userEmailsList =
    user.emailAddresses && user.emailAddresses.length
      ? user.emailAddresses
      : null;

  // User Display Name
  const userName = userNamesList ? userNamesList[0].displayName : null;
  // User Id
  const userId =
    userNamesList &&
    userNamesList[0].metadata &&
    userNamesList[0].metadata.source
      ? userNamesList[0].metadata.source.id
      : null;

      //user location 
  const userLocation =   userLocationList? userLocationList[0].current:null;

  //  const userPhone = userPhotosList ? userPhoneList[0].value:null

  // User Avatar
  const userAvatar =
    userPhotosList && userPhotosList[0].url ? userPhotosList[0].url : null;

  const userEmail =
    userEmailsList && userEmailsList[0].value ? userEmailsList[0].value : null;

  if (!userId || !userName || !userAvatar || !userEmail) {
    throw new Error("Google login error");
  }

  const updateRes = await db.users.findOneAndUpdate(
    { _id: userId },
    {
      $set: {
        name: userName,
        avatar: userAvatar,
        contact: userEmail,
        token,
      },
    },

    { returnDocument: "after" }
  );

  let viewer = updateRes.value;

  if (!viewer) {
    const insertResult = await db.users.insertOne({
      _id: userId,
      token,
      name: userName,
      avatar: userAvatar,
      contact: userEmail,
      income: 0,
      bookings: [],
      listings: [],
    });

    viewer = await db.users.findOne({ _id: insertResult.insertedId });
  }

  res.cookie("viewer", userId, {
    ...cookieOptions,
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });

  return viewer;
};

export const viewerResolvers: IResolvers = {
  Query: {
    authUrl: (): string => {
      try {
        return Google.authUrl;
      } catch (error) {
        throw new Error(`Failed to query Google Auth Url: ${error}`);
      }
    },
  },
  Mutation: {
    logIn: async (
      _root: undefined,
      { input }: LogInArgs,
      { db, res, req }: { db: Database; res: Response; req: Request }
    ): Promise<Viewer> => {
      try {
        const code = input ? input.code : null;
        const token = crypto.randomBytes(16).toString("hex");

        const viewer: User | null = code
          ? await logInViaGoogle(code, token, db,res)
          : await logInViaCookie(token,db,req,res);

        if (!viewer) {
          return { didRequest: true };
        }

        return {
          _id: viewer._id,
          token: viewer.token,
          avatar: viewer.avatar,
          walletId: viewer.walletId,
          didRequest: true,
        };
      } catch (error) {
        throw new Error(`Failed to log in: ${error}`);
      }
    },
    logOut: (
      _root: undefined,
      _args: {},
      { res }: { res: Response }
    ): Viewer => {
      try {
        res.clearCookie("viewer", cookieOptions);
        return { didRequest: true };
      } catch (error) {
        throw new Error(`Failed to log out: ${error}`);
      }
    },
    connectStripe:async(
      _root: undefined,
      { input }: ConnectStripeArgs,
      { db, req }: { db: Database; req: Request }
    ):Promise<Viewer>=>{
      try {
        const { code } = input;

        let viewer = await authorize(db, req);
        if (!viewer) {
          throw new Error("viewer cannot be found");
        }

        const wallet = await Stripe.connect(code);
        if (!wallet) {
          throw new Error("stripe grant error");
        }

        const updateRes = await db.users.findOneAndUpdate(
          { _id: viewer._id },
          { $set: { walletId: wallet.stripe_user_id } },
          { returnDocument: "after" }
        );

        if (!updateRes.value) {
          throw new Error("viewer could not be updated");
        }

        viewer = updateRes.value;

        return {
          _id: viewer._id,
          token: viewer.token,
          avatar: viewer.avatar,
          walletId: viewer.walletId,
          didRequest: true
        };
      } catch (error) {
        throw new Error(`Failed to connect with Stripe: ${error}`);
      }
    },
    disconnectStripe:async(
      _root: undefined,
      _args: {},
      { db, req }: { db: Database; req: Request }
    ):Promise<Viewer>=>{
      try {
        let viewer = await authorize(db, req);
        if (!viewer) {
          throw new Error(
            "viewer cannot be found or has not connected with Stripe"
          );
        }


        const updateRes = await db.users.findOneAndUpdate(
          { _id: viewer._id },
          { $set: { walletId: null } },
          { returnDocument: "after" }
        );

        if (!updateRes.value) {
          throw new Error("viewer could not be updated");
        }

        viewer = updateRes.value;

        return {
          _id: viewer._id,
          token: viewer.token,
          avatar: viewer.avatar,
          walletId: viewer.walletId,
          didRequest: true
        };
      } catch (error) {
        throw new Error(`Failed to disconnect with Stripe: ${error}`);
      }
    }
  },
  Viewer: {
    id: (viewer: Viewer): string | undefined => {
      return viewer._id;
    },

    hasWallet: (viewer: Viewer): boolean | undefined => {
      return viewer.walletId ? true : undefined;
    },
  },
};
